package app.penmoss.engine.git

import org.eclipse.jgit.lib.Config
import org.eclipse.jgit.storage.file.FileBasedConfig
import org.eclipse.jgit.storage.file.WindowCacheConfig
import org.eclipse.jgit.util.FS
import org.eclipse.jgit.util.SystemReader
import java.io.File

/**
 * JGit as a phone runs it (T50 G7, A824, G0 change 5), set up once per process:
 *
 * - **No user, system or XDG git config.** A phone has none, and a JVM test's must not leak in:
 *   a `url.<base>.insteadOf` in someone's `~/.gitconfig` would send the notes, and the token,
 *   elsewhere. Only each clone's own config counts, which Penmoss writes and checks (A855).
 * - **Small caches:** a 16 MB pack limit, 8 KB windows, no mmap, and no JMX statistics (Android
 *   has no `java.lang.management`).
 */
object JGitSetup {
    @Volatile
    private var installed = false

    /** [dir] holds the empty stand-ins for the configs JGit would read (never written). */
    @Synchronized
    fun install(dir: File) {
        if (installed) return
        dir.mkdirs()
        SystemReader.setInstance(IsolatedReader(SystemReader.getInstance(), dir))
        WindowCacheConfig().apply {
            packedGitLimit = 16L * 1024 * 1024
            packedGitWindowSize = 8 * 1024
            isPackedGitMMAP = false
            deltaBaseCacheLimit = 4 * 1024 * 1024
            streamFileThreshold = 1024 * 1024
            setExposeStatsViaJmx(false)
        }.install()
        installed = true
    }

    /** The version of JGit in use, for Status and the evidence. */
    val version: String
        get() = org.eclipse.jgit.lib.Repository::class.java.`package`?.implementationVersion ?: "unknown"

    /** The platform's clocks and environment, with empty configs in place of the user's and system's. */
    private class IsolatedReader(base: SystemReader, private val dir: File) : SystemReader.Delegate(base) {
        private fun empty(parent: Config?, fs: FS, name: String) = FileBasedConfig(parent, File(dir, name), fs)

        override fun openUserConfig(parent: Config?, fs: FS): FileBasedConfig = empty(parent, fs, "no-user-gitconfig")

        override fun openSystemConfig(parent: Config?, fs: FS): FileBasedConfig = empty(parent, fs, "no-system-gitconfig")

        override fun openJGitConfig(parent: Config?, fs: FS): FileBasedConfig = empty(parent, fs, "no-jgit-config")

        override fun getHostname(): String = "penmoss"
    }
}
