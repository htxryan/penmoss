package app.penmoss.gitprobe;

import java.io.File;
import java.nio.file.Files;

/**
 * The probe on the JVM: {@code GIT_TOKEN=… ./gradlew :jvm:run --args="<url> <branch> [work dir]"}.
 * The token is read from the environment only, never from argv.
 */
public final class Main {
  private Main() {}

  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      System.err.println("usage: GIT_TOKEN=… probe <https url> <branch> [work dir]");
      System.exit(2);
    }
    String token = System.getenv("GIT_TOKEN");
    if (token == null || token.isEmpty()) {
      System.err.println("GIT_TOKEN is not set");
      System.exit(2);
    }
    File work = args.length > 2 ? new File(args[2]) : Files.createTempDirectory("gitprobe").toFile();
    GitProbe.isolateConfig(work);
    GitProbe.lowMemoryConfig();
    GitProbe.Result result = GitProbe.run(work, args[0], args[1], token, System.out::println);
    System.out.printf("max heap %d MB%n", Runtime.getRuntime().maxMemory() / 1048576);
    GitProbe.deleteTree(new File(work, "clone"));
    System.exit(result.ok ? 0 : 1);
  }
}
