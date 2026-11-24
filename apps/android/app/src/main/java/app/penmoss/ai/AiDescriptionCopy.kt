package app.penmoss.ai

/**
 * The words the Mac and the phone say about descriptions (A1677, A1646): each prompt's warning
 * without the token that carries the text, Generate All's confirmation and Choose an AI
 * Provider's body. Core's `AI_DESCRIPTION_COPY` keeps them once for both; these are its words,
 * and `AiDescriptionsContractTest` checks each, and [generateAllWords] for a few counts, against
 * `apps/android/contract/ai-descriptions-v1.json`. A `{count}` is filled in by [generateAllWords].
 */
object AiDescriptionCopy {
    val TEXT: Map<String, String> = linkedMapOf(
        "notePrompt.missing" to "This prompt has no {{body}} token, so Claude won’t see the note’s text.",
        "tagPrompt.missing" to "This prompt has no {{notes}} token, so Claude won’t see the tag’s notes.",
        "generateAll.none" to "There are no tags to describe.",
        "generateAll.allDescribed" to "Every tag has a description already.",
        "generateAll.replace.one" to "1 tag will be described, replacing any description they have.",
        "generateAll.replace.many" to "{count} tags will be described, replacing any description they have.",
        "generateAll.missing.one" to "1 tag has no description.",
        "generateAll.missing.many" to "{count} tags have no description.",
        "generateAll.each" to "Each goes to your AI provider with its notes’ titles and descriptions, two at a time.",
        "chooseProvider.body" to "Generating a description sends the tag’s notes to your AI provider. Choose one in Settings → AI Descriptions first.",
    )

    fun text(key: String): String = TEXT[key] ?: error("No AI description copy for $key")

    /** What Generate All says it covers before anything is sent (core's `generateAllTagsWords`). */
    fun generateAllWords(count: Int, replace: Boolean): String {
        if (count == 0) return text(if (replace) "generateAll.none" else "generateAll.allDescribed")
        val lead = when {
            replace -> if (count == 1) "generateAll.replace.one" else "generateAll.replace.many"
            else -> if (count == 1) "generateAll.missing.one" else "generateAll.missing.many"
        }
        return "${text(lead).replace("{count}", count.toString())} ${text("generateAll.each")}"
    }
}

/** The longest tag description kept (core's `TAG_DESCRIPTION_MAX`, A1364; the contract's `tagDescriptionMax`). */
const val TAG_DESCRIPTION_MAX = 2000
