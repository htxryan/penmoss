package app.penmoss.engine.git

/**
 * What the git notebook engine's transport says (T50 G7, A824, A870): the codes
 * `@penmoss/git-notebook`'s `GitTransportError` has, so the engine page reads a refusal from
 * JGit as it reads one from system git on the Mac. Kotlin only moves bytes (A11): what the files
 * hold is the page's business.
 */
enum class GitErrorCode(val wire: String) {
    AUTH("auth"),
    NETWORK("network"),
    NOT_FOUND("not_found"),
    HOST_KEY("host_key"),
    SIGNING("signing"),
    PROTECTED("protected"),
    RULES("rules"),
    REFUSED("refused"),
    GIT_MISSING("git_missing"),
    TIMEOUT("timeout"),
    REDIRECTED("redirected"),
    GIT("git"),
    ;

    companion object {
        fun of(wire: String): GitErrorCode = entries.firstOrNull { it.wire == wire } ?: GIT
    }
}

/** A git call that failed, with our words and, when the host said something, its own (A824). */
class GitException(
    val code: GitErrorCode,
    message: String,
    val hostMessage: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

/** A commit as History lists it (`CommitInfo` in the engine). */
data class GitCommitInfo(
    val id: String,
    val parents: List<String>,
    val authorName: String,
    val authorEmail: String,
    /** Epoch ms. */
    val at: Long,
    val message: String,
)

enum class PushOutcome(val wire: String) { PUSHED("pushed"), REJECTED("rejected") }

/** Who commits from this phone (A825): the name and email set in Settings → Git notebooks. */
data class GitIdentity(val name: String, val email: String) {
    companion object {
        /** Where none is set: the writer's label, as the Mac does without git's config. */
        fun fallback(label: String) = GitIdentity(label.ifBlank { "Penmoss for Android" }, "penmoss@localhost")
    }
}

/** A personal access token (A824: the Keystore holds it) and the user name sent with it. */
data class GitCredentials(val token: String, val user: String = DEFAULT_TOKEN_USER) {
    override fun toString(): String = "GitCredentials(user=$user, token=***)"

    companion object {
        /** What github.com takes as the user name with a token. */
        const val DEFAULT_TOKEN_USER = "x-access-token"
    }
}
