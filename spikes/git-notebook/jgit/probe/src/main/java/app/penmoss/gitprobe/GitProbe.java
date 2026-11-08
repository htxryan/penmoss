package app.penmoss.gitprobe;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheBuilder;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.lib.CommitBuilder;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.lib.StoredConfig;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.storage.file.FileBasedConfig;
import org.eclipse.jgit.storage.file.WindowCacheConfig;
import org.eclipse.jgit.transport.FetchResult;
import org.eclipse.jgit.transport.PushResult;
import org.eclipse.jgit.transport.RefSpec;
import org.eclipse.jgit.transport.RemoteRefUpdate;
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.eclipse.jgit.util.FS;
import org.eclipse.jgit.util.SystemReader;

/**
 * What the Android transport (A744) must do, with JGit: a shallow clone with no checkout, a
 * fetch, a commit built on the remote head from bytes (a writer's log and a rendered note, no
 * working tree, no merge), a fast-forward push, and a push that must be rejected. Every step is
 * timed, and the JVM heap is sampled throughout. Plain Java, so the same code runs on the
 * worker's JVM and in the throwaway Android activity.
 */
public final class GitProbe {
  public interface Log {
    void line(String text);
  }

  public static final class Step {
    public final String name;
    public final long ms;
    public final String detail;

    Step(String name, long ms, String detail) {
      this.name = name;
      this.ms = ms;
      this.detail = detail;
    }
  }

  public static final class Result {
    public final List<Step> steps = new ArrayList<>();
    public long peakHeapBytes;
    public long gitDirBytes;
    public int filesAtHead;
    public String jgitVersion;
    public boolean ok;
    public String error;
  }

  private GitProbe() {}

  /** Small caches, as a phone needs (risks: memory on large repos). */
  public static void lowMemoryConfig() {
    WindowCacheConfig config = new WindowCacheConfig();
    config.setPackedGitLimit(16 * 1024 * 1024);
    config.setPackedGitWindowSize(8 * 1024);
    config.setPackedGitMMAP(false);
    config.setDeltaBaseCacheLimit(4 * 1024 * 1024);
    config.setStreamFileThreshold(1024 * 1024);
    // JMX statistics would reach java.lang.management, which Android lacks (R8 lists it missing).
    config.setExposeStatsViaJmx(false);
    config.install();
  }

  /**
   * No user, system or XDG git config: a phone has none, and the worker's must not leak in
   * (the risks section's test isolation). JGit reads these through SystemReader.
   */
  public static void isolateConfig(File dir) {
    SystemReader.setInstance(new IsolatedReader(SystemReader.getInstance(), dir));
  }

  /** The platform's reader for clocks and the environment, and empty configs (JGit 6.6 has no Delegate). */
  static final class IsolatedReader extends SystemReader {
    private final SystemReader base;
    private final File dir;

    IsolatedReader(SystemReader base, File dir) {
      this.base = base;
      this.dir = dir;
    }

    private FileBasedConfig empty(Config parent, FS fs, String name) {
      return new FileBasedConfig(parent, new File(dir, name), fs);
    }

    @Override
    public String getHostname() {
      return "penmoss-probe";
    }

    @Override
    public String getenv(String variable) {
      return base.getenv(variable);
    }

    @Override
    public String getProperty(String key) {
      return base.getProperty(key);
    }

    @Override
    public FileBasedConfig openUserConfig(Config parent, FS fs) {
      return empty(parent, fs, "no-user-gitconfig");
    }

    @Override
    public FileBasedConfig openSystemConfig(Config parent, FS fs) {
      return empty(parent, fs, "no-system-gitconfig");
    }

    @Override
    public FileBasedConfig openJGitConfig(Config parent, FS fs) {
      return empty(parent, fs, "no-jgit-config");
    }

    @Override
    public long getCurrentTime() {
      return base.getCurrentTime();
    }

    @Override
    public int getTimezone(long when) {
      return base.getTimezone(when);
    }
  }

  public static Result run(File work, String url, String branch, String token, Log log) {
    Result result = new Result();
    result.jgitVersion = jgitVersion();
    HeapSampler sampler = new HeapSampler();
    sampler.start();
    UsernamePasswordCredentialsProvider auth = new UsernamePasswordCredentialsProvider("x-access-token", token);
    File dir = new File(work, "clone");
    deleteTree(dir);
    try {
      log.line("JGit " + result.jgitVersion + ", target " + url + " @ " + branch);
      long t0 = System.nanoTime();
      try (Git git =
          Git.cloneRepository()
              .setURI(url)
              .setDirectory(dir)
              .setBranch(branch)
              .setBranchesToClone(List.of(Constants.R_HEADS + branch))
              .setCloneAllBranches(false)
              .setDepth(1)
              .setNoCheckout(true)
              .setCredentialsProvider(auth)
              .call()) {
        step(result, log, "shallow clone (depth 1, no checkout)", t0, "");
        Repository repo = git.getRepository();
        StoredConfig config = repo.getConfig();
        config.setBoolean("gc", null, "autoDetach", false);
        config.setInt("gc", null, "auto", 0);
        config.save();

        t0 = System.nanoTime();
        ObjectId head = repo.resolve(Constants.R_REMOTES + "origin/" + branch);
        int files = countFiles(repo, head);
        result.filesAtHead = files;
        step(result, log, "list the head's tree", t0, files + " files");

        t0 = System.nanoTime();
        int read = readLogs(repo, head);
        step(result, log, "read every writer log at head", t0, read + " bytes");

        t0 = System.nanoTime();
        FetchResult fetched = git.fetch().setRemote("origin").setDepth(1).setCredentialsProvider(auth)
            .setRefSpecs(new RefSpec("+" + Constants.R_HEADS + branch + ":" + Constants.R_REMOTES + "origin/" + branch))
            .call();
        step(result, log, "fetch (nothing new)", t0, fetched.getTrackingRefUpdates().size() + " ref updates");

        // A writer's sync: a commit on the remote head that sets two files, then a fast-forward push.
        String writer = "01JPIXEL" + randomId(18);
        t0 = System.nanoTime();
        ObjectId commit = commitOnHead(repo, head, writer, 2048);
        step(result, log, "commit on the remote head (2 files)", t0, commit.name().substring(0, 12));

        t0 = System.nanoTime();
        RemoteRefUpdate.Status status = push(git, auth, commit, branch);
        step(result, log, "push (fast-forward)", t0, status.name());
        if (status != RemoteRefUpdate.Status.OK) throw new IOException("push was " + status);

        // Another device pushed meanwhile: a commit on the old head must be rejected, never merged.
        t0 = System.nanoTime();
        ObjectId stale = commitOnHead(repo, head, writer, 512);
        RemoteRefUpdate.Status rejected = push(git, auth, stale, branch);
        step(result, log, "push on a stale head (must be rejected)", t0, rejected.name());
        if (rejected != RemoteRefUpdate.Status.REJECTED_NONFASTFORWARD) throw new IOException("stale push was " + rejected);

        t0 = System.nanoTime();
        git.fetch().setRemote("origin").setDepth(1).setCredentialsProvider(auth)
            .setRefSpecs(new RefSpec("+" + Constants.R_HEADS + branch + ":" + Constants.R_REMOTES + "origin/" + branch))
            .call();
        ObjectId after = repo.resolve(Constants.R_REMOTES + "origin/" + branch);
        step(result, log, "fetch after the push", t0, after.equals(commit) ? "head is our commit" : "head moved: " + after.name());

        // The rebuild after a rejection: on top of the new head, then push again.
        t0 = System.nanoTime();
        ObjectId again = commitOnHead(repo, after, writer, 1024);
        RemoteRefUpdate.Status second = push(git, auth, again, branch);
        step(result, log, "rebuild on the new head and push", t0, second.name());
        if (second != RemoteRefUpdate.Status.OK) throw new IOException("second push was " + second);
      }
      result.gitDirBytes = treeBytes(new File(dir, ".git"));
      result.ok = true;
    } catch (Exception e) {
      result.error = e.getClass().getSimpleName() + ": " + e.getMessage();
      log.line("FAILED: " + result.error);
      Throwable cause = e.getCause();
      while (cause != null) {
        log.line("  caused by " + cause.getClass().getName() + ": " + cause.getMessage());
        cause = cause.getCause();
      }
    } finally {
      result.peakHeapBytes = sampler.stopAndPeak();
    }
    log.line(String.format(Locale.ROOT, "peak heap %.1f MB, .git %.1f MB, %d files at head", result.peakHeapBytes / 1048576.0, result.gitDirBytes / 1048576.0, result.filesAtHead));
    return result;
  }

  private static void step(Result result, Log log, String name, long startNanos, String detail) {
    long ms = (System.nanoTime() - startNanos) / 1_000_000;
    result.steps.add(new Step(name, ms, detail));
    log.line(String.format(Locale.ROOT, "%-42s %6d ms  %s", name, ms, detail));
  }

  private static RemoteRefUpdate.Status push(Git git, UsernamePasswordCredentialsProvider auth, ObjectId commit, String branch) throws Exception {
    Iterable<PushResult> results = git.push().setRemote("origin").setCredentialsProvider(auth).setAtomic(false)
        .setRefSpecs(new RefSpec(commit.name() + ":" + Constants.R_HEADS + branch))
        .call();
    for (PushResult r : results) {
      Collection<RemoteRefUpdate> updates = r.getRemoteUpdates();
      for (RemoteRefUpdate u : updates) return u.getStatus();
    }
    throw new IOException("no push result");
  }

  /** The head's tree plus two files, as a git notebook writer commits (A741, A742). */
  static ObjectId commitOnHead(Repository repo, ObjectId head, String writer, int logBytes) throws IOException {
    try (ObjectInserter inserter = repo.newObjectInserter(); RevWalk walk = new RevWalk(repo)) {
      RevCommit parent = walk.parseCommit(head);
      byte[] log = new byte[logBytes];
      new SecureRandom().nextBytes(log);
      ObjectId logBlob = inserter.insert(Constants.OBJ_BLOB, log);
      String noteId = "01JPIXELNOTE" + randomId(14);
      ObjectId mdBlob = inserter.insert(Constants.OBJ_BLOB, ("---\nid: " + noteId + "\ntitle: From JGit\n---\n\nWritten by the JGit probe.\n").getBytes(StandardCharsets.UTF_8));
      DirCache index = DirCache.newInCore();
      DirCacheBuilder builder = index.builder();
      builder.addTree(new byte[0], 0, repo.newObjectReader(), parent.getTree());
      builder.add(entry(".penmoss/notes/" + noteId + "/" + writer + ".yjs", logBlob));
      builder.add(entry("JGit probe/" + noteId + ".md", mdBlob));
      builder.finish();
      ObjectId tree = index.writeTree(inserter);
      CommitBuilder commit = new CommitBuilder();
      PersonIdent who = new PersonIdent("Penmoss JGit probe", "probe@example.invalid");
      commit.setAuthor(who);
      commit.setCommitter(who);
      commit.setParentId(parent);
      commit.setTreeId(tree);
      commit.setMessage("Penmoss: 1 note [skip ci]\n");
      ObjectId id = inserter.insert(commit);
      inserter.flush();
      return id;
    }
  }

  private static DirCacheEntry entry(String path, ObjectId blob) {
    DirCacheEntry e = new DirCacheEntry(path);
    e.setFileMode(FileMode.REGULAR_FILE);
    e.setObjectId(blob);
    return e;
  }

  private static int countFiles(Repository repo, ObjectId head) throws IOException {
    try (RevWalk walk = new RevWalk(repo); TreeWalk tree = new TreeWalk(repo)) {
      tree.addTree(walk.parseCommit(head).getTree());
      tree.setRecursive(true);
      int n = 0;
      while (tree.next()) n++;
      return n;
    }
  }

  /** Reads every `.yjs` blob at head, as the engine's first sync does. */
  private static int readLogs(Repository repo, ObjectId head) throws IOException {
    try (RevWalk walk = new RevWalk(repo); TreeWalk tree = new TreeWalk(repo)) {
      tree.addTree(walk.parseCommit(head).getTree());
      tree.setRecursive(true);
      int bytes = 0;
      while (tree.next()) {
        if (!tree.getPathString().endsWith(".yjs")) continue;
        bytes += repo.open(tree.getObjectId(0)).getBytes().length;
      }
      return bytes;
    }
  }

  static String jgitVersion() {
    Package p = Repository.class.getPackage();
    String v = p == null ? null : p.getImplementationVersion();
    return v == null ? System.getProperty("jgit.version", "unknown") : v;
  }

  private static String randomId(int n) {
    String alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    SecureRandom random = new SecureRandom();
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < n; i++) out.append(alphabet.charAt(random.nextInt(32)));
    return out.toString();
  }

  static void deleteTree(File f) {
    File[] children = f.listFiles();
    if (children != null) for (File c : children) deleteTree(c);
    f.delete();
  }

  static long treeBytes(File f) {
    if (f.isFile()) return f.length();
    long total = 0;
    File[] children = f.listFiles();
    if (children != null) for (File c : children) total += treeBytes(c);
    return total;
  }

  /** Samples used heap every 10 ms; the peak is what the probe needed at most. */
  static final class HeapSampler extends Thread {
    private volatile boolean running = true;
    private volatile long peak;

    HeapSampler() {
      setDaemon(true);
      setName("heap-sampler");
    }

    @Override
    public void run() {
      Runtime rt = Runtime.getRuntime();
      while (running) {
        long used = rt.totalMemory() - rt.freeMemory();
        if (used > peak) peak = used;
        try {
          Thread.sleep(10);
        } catch (InterruptedException e) {
          return;
        }
      }
    }

    long stopAndPeak() {
      running = false;
      Runtime rt = Runtime.getRuntime();
      long used = rt.totalMemory() - rt.freeMemory();
      return Math.max(peak, used);
    }
  }
}
