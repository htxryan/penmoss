package app.penmoss.engine.git

import org.eclipse.jgit.lib.Repository
import java.net.URI

/**
 * A git notebook's remote as Android takes one (T50 G7, A824, A841): HTTPS (a token in the
 * Keystore, never in the URL) or a `file://` repository on this phone, which Penmoss cannot ask
 * about and so syncs without a check (D51). SSH is not supported on Android (#147). As `remoteParts` in
 * `@penmoss/git-notebook/node`, so a remote reads the same on every client.
 */
object GitRemotes {
    enum class Protocol { HTTPS, HTTP, FILE }

    data class Parts(
        /** `github.com`; '' for a repository on this phone. */
        val host: String,
        /** `owner/repo` on github.com, else the path (no `.git`, no slashes at the ends). */
        val path: String,
        val protocol: Protocol,
        /** A user name or password in the URL (`https://token@host/…`): refused. */
        val credentials: Boolean,
    )

    private val SCP = Regex("^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!//)(.+)$")

    /** The parts of an HTTPS, HTTP or `file://` remote; null for anything else (SSH included). */
    fun parts(remote: String): Parts? {
        if (remote.isBlank() || remote.length > 2000 || remote.any { it.isISOControl() }) return null
        if (SCP.matches(remote)) return null
        val uri = runCatching { URI(remote) }.getOrNull() ?: return null
        return when (uri.scheme?.lowercase()) {
            "file" -> uri.path?.takeIf { it.startsWith("/") }?.let { Parts("", it, Protocol.FILE, false) }
            "https", "http" -> {
                val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
                Parts(
                    host = host,
                    path = clean(uri.path.orEmpty()),
                    protocol = if (uri.scheme.equals("https", ignoreCase = true)) Protocol.HTTPS else Protocol.HTTP,
                    credentials = uri.rawUserInfo != null,
                )
            }
            else -> null
        }
    }

    /** Whether Android can sync with it: SSH and others are not supported here (A824). */
    fun isSsh(remote: String): Boolean =
        SCP.matches(remote) || remote.startsWith("ssh://", ignoreCase = true) || remote.startsWith("git+ssh://", ignoreCase = true)

    fun hostOf(remote: String): String? = parts(remote)?.host?.ifEmpty { null }

    /** A remote as it may be shown: an HTTP URL's user name and password replaced. */
    fun redact(remote: String): String = remote.replace(Regex("^(https?://)[^/@]*@", RegexOption.IGNORE_CASE), "$1***@")

    /** How the person sees a repository: `github.com/owner/repo`, or a path on this phone. */
    fun repositoryName(remote: String): String {
        val parts = parts(remote) ?: return redact(remote)
        if (parts.protocol == Protocol.FILE) return "this phone: ${parts.path}"
        return "${parts.host}/${parts.path}"
    }

    /** A repository in the owner check's words (A855). */
    fun repositoryWords(remote: String): String {
        val parts = parts(remote)
        if (parts?.protocol == Protocol.FILE) return "${parts.path} on this phone"
        return repositoryName(remote)
    }

    private fun clean(path: String): String = path.trim('/').removeSuffix(".git")

    /** A notebook directory as stored (no slashes at the ends), or null when invalid. */
    fun cleanDir(value: String?): String? {
        val trimmed = (value ?: "").trim().trim('/')
        if (trimmed.isEmpty()) return ""
        val parts = trimmed.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." || it.equals(".git", ignoreCase = true) }) return null
        if (trimmed.length > 200 || trimmed.any { it.isISOControl() || it == '\\' }) return null
        return trimmed
    }

    /** The layout root for a directory: `docs/notes` → `docs/notes/`, '' → ''. */
    fun rootOf(dir: String): String = if (dir.isEmpty()) "" else "$dir/"

    /** Whether git takes [branch] as a branch name (`git check-ref-format --branch`). */
    fun branchOk(branch: String): Boolean =
        branch.isNotBlank() && !branch.startsWith("-") && branch.length <= 200 && Repository.isValidRefName("refs/heads/$branch")
}
