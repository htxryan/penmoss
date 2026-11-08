package app.penmoss.engine.api

import kotlinx.serialization.Serializable

/**
 * Send to… (T60, D50, A1060, A1076): the agent sessions a git notebook's WorkspaceDoc lists,
 * `GET /android/agent-sessions` on its notes server in the engine page, never a Penmoss server.
 * The threads themselves live in the note's own document, which the editor page reads and
 * writes; only the list of sessions is the notebook's.
 */
interface PenmossCommentsApi {
    suspend fun agentSessions(): AgentSessionList
}

/**
 * Every listed session, Send to…'s ([AgentSession.offered]) first, running ones before them;
 * [synced]: a sync has landed since the engine page opened, so a session missing here is gone.
 */
@Serializable
data class AgentSessionList(
    val now: Long = 0,
    val synced: Boolean = false,
    val sessions: List<AgentSession> = emptyList(),
) {
    /** What Send to… offers: seen this week, running ones first. */
    val offered: List<AgentSession> get() = sessions.filter { it.offered }
}

/** One Claude Code session's `penmoss mcp --channel` entry (`agentSessions` in the WorkspaceDoc). */
@Serializable
data class AgentSession(
    /** `sessionKey(writer, name)`: 24 hex digits. */
    val key: String,
    /** The agent clone's writer id. */
    val writer: String,
    val label: String = "",
    val name: String = "",
    val host: String = "",
    val startedAt: Long = 0,
    val lastSeen: Long = 0,
    /** Seen within two hours: running. */
    val active: Boolean = false,
    /** Seen within a week: Send to… offers it. */
    val offered: Boolean = false,
)
