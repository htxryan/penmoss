package app.penmoss.engine.git

import kotlinx.serialization.json.JsonElement

/**
 * AI Descriptions for a notebook's engine page (PEN-161, A1656): the app's side. The page asks
 * what is set ([config]: whether this phone has a provider it can call, Describe Notes, when, the
 * pause and the prompt) and sends a finished prompt ([describe]); the key, the provider and the
 * model never reach the page.
 */
interface AiHost {
    /** `{ready, global, when, pauseS, prompt}`, as the page's `parseAiConfig` reads it. */
    suspend fun config(): JsonElement

    /** `{ok: true, text}` or `{ok: false, code, message}`, as the page's `parseAiAnswer` reads it. */
    suspend fun describe(prompt: String): JsonElement

    companion object {
        /** The longest prompt the page may send: the body's cut (24,000 tokens) and the rest. */
        const val MAX_PROMPT_CHARS = 120_000
    }
}
