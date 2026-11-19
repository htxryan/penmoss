package app.penmoss.analytics

/**
 * Every string the analytics screens show on the phone (PEN-137, Copy and Title Case): the consent
 * question, Settings → Privacy, Advanced, the viewer, the confirmations and Send Feedback's logs
 * box. Core's `copy.ts` keeps them once for both platforms; these are its Android words, and
 * `AnalyticsCopyContractTest` checks each against `apps/android/contract/analytics-copy-v1.json`.
 * A `{name}` is filled in by [AnalyticsCopy.text], numbers in en-US.
 */
object AnalyticsCopy {
    val TEXT: Map<String, String> = linkedMapOf(
        "consent.title" to "Share How You Use Penmoss?",
        "consent.lastStep.label" to "Last Step",
        "consent.body" to "Penmoss keeps a record of what you do in it, by name, on this phone, and Settings → Privacy shows it. Share Usage Data sends it, this setup included, to Penmoss’s developer. Don’t Share keeps it on this phone.",
        "consent.recorded.title" to "What Is Recorded",
        "consent.recorded.1" to "The commands, shortcuts, buttons and menus you use, by name",
        "consent.recorded.2" to "The screens and dialogs you open, and the settings you change",
        "consent.recorded.3" to "The app’s version, the system’s version and the window’s size",
        "consent.recorded.4" to "",
        "consent.never.title" to "Never Recorded",
        "consent.never.1" to "What you write: notes, titles, tags, links and searches",
        "consent.never.2" to "The names of notebooks, folders, files and repositories",
        "consent.never.3" to "Your GitHub account, email address or tokens",
        "consent.share.button" to "Share Usage Data",
        "consent.dontShare.button" to "Don’t Share",
        "consent.policy.label" to "Privacy Policy",
        "consent.later" to "You can change this at any time in Settings → Privacy, and see what is recorded there.",
        "privacy.title" to "Privacy",
        "privacy.lead" to "Penmoss records what you do in it, by name, on this phone, and never anything you write or name.",
        "privacy.share.label" to "Share Usage Data",
        "privacy.share.hint" to "Sends the record to Penmoss’s developer from now on. Off, it stays on this phone.",
        "privacy.viewData.label" to "View Analytics Data",
        "privacy.id.label" to "Analytics ID",
        "privacy.id.hint" to "A random ID you can reset. It says nothing about you.",
        "privacy.resetId.button" to "Reset My Analytics ID",
        "privacy.resetId.done" to "A new ID is in use. Events not yet sent stay on this phone.",
        "privacy.forget.button" to "Delete My Shared Data",
        "privacy.logs.label" to "Logs",
        "privacy.logs.button" to "Share Log File",
        "privacy.logs.hint" to "The last {days} days, on this phone. They leave only when you attach them to a bug report or share them.",
        "privacy.advanced.label" to "Advanced",
        "privacy.advanced.intro" to "How much Penmoss keeps on this phone. Lowering a limit asks first, then deletes what falls outside it.",
        "privacy.policy.label" to "Privacy Policy",
        "limits.usage.title" to "Usage Record",
        "limits.logs.title" to "Logs",
        "limits.report.title" to "Bug Reports",
        "limits.events.days.label" to "Keep Events For",
        "limits.events.max.label" to "Keep at Most",
        "limits.logs.fileKb.label" to "Log File Size",
        "limits.logs.files.label" to "Log Files Kept",
        "limits.logs.days.label" to "Keep Log Lines For",
        "limits.report.hours.label" to "Attach Logs from the Last",
        "limits.report.lines.label" to "At Most",
        "limits.report.kb.label" to "At Most",
        "limits.default" to "Default: {value}",
        "limits.range" to "Between {min} and {max}",
        "limits.usage.space" to "About {size} of events at most on this phone",
        "limits.logs.space" to "Up to {size} of logs on this phone (at most 400 MB)",
        "limits.report.space" to "A bug report attaches the last {hours} hours, at most {lines} lines and {kb} KB.",
        "limits.reset.button" to "Reset to Defaults",
        "limits.reset.hint" to "",
        "confirm.cancel.button" to "Cancel",
        "confirm.delete.button" to "Delete",
        "forget.title" to "Delete Your Shared Data?",
        "forget.body" to "Penmoss’s server deletes everything this phone shared under ID {id}, and this phone gets a new ID. The record on this phone stays.",
        "forget.offline" to "You’re offline, so nothing was deleted. Try again when you’re online.",
        "forget.failed" to "Penmoss’s server didn’t answer, so nothing was deleted. Try again later.",
        "forget.done" to "Your shared data was deleted, and this phone has a new ID.",
        "prune.events.title" to "Delete {count} Events?",
        "prune.logs.title" to "Delete {size} of Logs?",
        "prune.body" to "They’re {reason}. They’re deleted from this phone now, and raising the limit later won’t bring them back.",
        "prune.reason.age" to "older than {days} days",
        "prune.reason.cap" to "beyond the newest {max}",
        "prune.reason.size" to "beyond the new size",
        "viewer.title" to "Analytics Data",
        "viewer.summary" to "On this phone, kept {days} days. ID {id}. {sharing}",
        "viewer.sharing.on" to "Sharing since {date}.",
        "viewer.sharing.off" to "Not shared.",
        "viewer.sharing.unanswered" to "Waiting for your answer.",
        "viewer.filter.all.label" to "All",
        "viewer.filter.app.label" to "App",
        "viewer.filter.cli.label" to "CLI",
        "viewer.filter.mcp.label" to "MCP",
        "viewer.copyJson.button" to "Copy as JSON",
        "viewer.earlier.button" to "Earlier",
        "viewer.later.button" to "Later",
        "viewer.showing" to "Showing {from}–{to} of {total}",
        "viewer.empty.title" to "Nothing Recorded Yet",
        "viewer.col.time.label" to "Time",
        "viewer.col.client.label" to "Client",
        "viewer.col.kind.label" to "Kind",
        "viewer.col.name.label" to "Name",
        "viewer.col.props.label" to "Props",
        "viewer.col.state.label" to "State",
        "feedback.logs.label" to "Attach Anonymised Logs",
        "feedback.logs.summary" to "Anonymised Logs · {lines} lines · {size}",
        "feedback.logs.hint" to "The app’s logs from the last {hours} hours, at most {maxLines} lines and {kb} KB, with names, paths, IDs and secrets replaced. This is exactly what is attached.",
        "feedback.logs.empty" to "There are no logs from the last {hours} hours.",
        "feedback.logs.block.title" to "Anonymised Logs",
        "feedback.context.title" to "Captured Context",
        "state.pending" to "Waiting for Your Answer",
        "state.local" to "Not Shared",
        "state.waiting" to "Waiting to Send",
        "state.sent" to "Sent",
        "state.refused" to "Refused",
    )

    /** The words for [key], with [vars] filled in (a number as en-US writes it). */
    fun text(key: String, vararg vars: Pair<String, Any>): String {
        val template = TEXT[key] ?: error("No analytics copy for $key")
        val values = vars.toMap()
        return Regex("\\{(\\w+)\\}").replace(template) { match ->
            when (val value = values[match.groupValues[1]]) {
                null -> match.value
                is Int -> AnalyticsFormat.number(value.toLong())
                is Long -> AnalyticsFormat.number(value)
                else -> value.toString()
            }
        }
    }
}
