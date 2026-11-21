package app.penmoss.analytics

import java.io.File

/**
 * Reads the app's Kotlin sources for their controls (PEN-137, AC15), as the web's ESLint rule
 * `penmoss/tracked-control` reads the page: every clickable control (a Material button, switch,
 * check box, radio button, tab, menu item, chip or FAB, a clickable card or surface, and every
 * `clickable`, `combinedClickable`, `toggleable` or `selectable` modifier) must carry a tracked
 * id (`Modifier.tracked`, `trackedId`, `trackedClick`, `trackedToggle`, `Analytics.click`) or run
 * a command (`…Commands.run(`), which is counted by its run. Since PEN-175 the marker must be the
 * control's own (in its onClick or modifier, not in a `text = { … }` or trailing content), and
 * these count as controls too: a Slider or RangeSlider (a tracked `onValueChangeFinished`, so it
 * is recorded when let go), an ExposedDropdownMenuBox, a PullToRefreshBox, a `pointerInput` with
 * `detectTapGestures`, a `LinkAnnotation`, and each call of the first run's Primary, Plain,
 * Options and Link (an `event =`). A control that only swallows taps (a preview's shield) says
 * so with an `// untracked: <why>` comment, the why three words or more, on its line or the one
 * above. Every dialog and sheet is tracked by name (`rememberTrackedDialog`) where it is
 * composed. A text field inside a dialog or sheet records the length typed in it
 * (`Modifier.typedLength`, PEN-177) or says why not with an `// untracked:` reason. Each id
 * written as a literal is listed with where it is, for the catalogue check.
 */
object ControlScan {
    data class Use(val kind: String, val name: String, val where: String)

    data class Result(val problems: List<String>, val uses: List<Use>, val controls: Int, val dialogs: Int, val fields: Int = 0)

    private const val QUALIFIED = "(?<![\\w.])(?:[a-z][a-z0-9_]*\\.)*"

    private val CONTROLS = Regex(
        QUALIFIED + "(Button|TextButton|IconButton|OutlinedButton|FilledTonalButton|FilledIconButton|FilledTonalIconButton|" +
            "OutlinedIconButton|ElevatedButton|IconToggleButton|FloatingActionButton|SmallFloatingActionButton|" +
            "LargeFloatingActionButton|ExtendedFloatingActionButton|Switch|Checkbox|TriStateCheckbox|RadioButton|SegmentedButton|" +
            "Tab|LeadingIconTab|DropdownMenuItem|FilterChip|ElevatedFilterChip|AssistChip|ElevatedAssistChip|InputChip|" +
            "SuggestionChip|ElevatedSuggestionChip|NavigationBarItem|NavigationDrawerItem|NavigationRailItem|" +
            // The app's own controls that pass their onClick through: each caller names its id.
            "TipIconButton)\\s*\\(",
    )

    /** Containers that are clickable only when given an onClick. */
    private val CLICKABLE_CONTAINERS = Regex(QUALIFIED + "(Card|ElevatedCard|OutlinedCard|Surface)\\s*\\(")

    private val MODIFIERS = Regex("\\.(clickable|combinedClickable|toggleable|triStateToggleable|selectable)\\b")

    private val DIALOGS = Regex(QUALIFIED + "(AlertDialog|BasicAlertDialog|Dialog|ModalBottomSheet|DatePickerDialog|TimePickerDialog)\\s*\\(")

    /** Text fields (PEN-177): in a dialog or sheet, each records its typed length (`typedLength`). */
    private val TEXT_FIELDS = Regex(QUALIFIED + "(OutlinedTextField|TextField|BasicTextField)\\s*\\(")
    private val TYPED_LENGTH = Regex("\\btypedLength\\s*\\(")

    /** Sliders: recorded when let go, by a tracked `onValueChangeFinished` (PEN-175), never their value. */
    private val SLIDERS = Regex(QUALIFIED + "(Slider|RangeSlider)\\s*\\(")
    private val VALUE_FINISHED = Regex("\\bonValueChangeFinished\\s*=(?!=)")

    /** A drop-down (tracked by its box, its picks by their items) and a pull to refresh (by its onRefresh). */
    private val BOXES = Regex(QUALIFIED + "(ExposedDropdownMenuBox|PullToRefreshBox)\\s*\\(")

    /** A link in text: its listener records it. */
    private val LINKS = Regex("(?<![\\w.])(?:[a-z][a-z0-9_]*\\.)*LinkAnnotation\\.(Url|Clickable)\\s*\\(")

    /** A tap gesture of its own: `pointerInput(…) { detectTapGestures { … } }`. */
    private val POINTER_INPUT = Regex("\\.pointerInput\\b")
    private val TAP_GESTURES = Regex("\\bdetectTapGestures\\b")

    /**
     * The first run's own buttons and choices (FirstRunFrame.kt), which have no id of their own:
     * each call names its `event =` (PEN-175).
     */
    private val WRAPPERS = Regex(QUALIFIED + "(Primary|Plain|Options|Link)\\s*\\(")

    /** A named lambda argument that is a control's content (`text = { … }`), not what it does (`onClick = { … }`). */
    private val CONTENT_ARG = Regex("^\\s*(\\w+)\\s*=\\s*\\{")
    private val ACTION_ARG = Regex("^(on[A-Z]\\w*|linkInteractionListener)$")

    private val NO_ACTION = Regex("\\b(onClick|onCheckedChange|onSelectedChange)\\s*=\\s*null\\b")
    private val HAS_ON_CLICK = Regex("\\bonClick\\s*=")

    private val MARKERS = Regex("\\b(tracked|trackedId|trackedClick|trackedToggle)\\s*\\(|\\bAnalytics\\.click\\s*\\(|\\b\\w*[cC]ommands\\.run\\s*\\(")

    private val ID_CALLS = Regex("\\b(tracked|trackedId|trackedClick|trackedToggle|Analytics\\.click)\\s*\\(")
    private val EVENT_ARGS = Regex("\\bevent\\s*=(?!=)")
    private val DIALOG_CALLS = Regex("\\brememberTrackedDialog\\s*\\(")
    private val UNTRACKED = Regex("//\\s*untracked:(.*)$")

    /** An `// untracked:` reason says why in three words or more (PEN-175), as the web's `data-untracked`. */
    private const val REASON_WORDS = 3

    private fun reasonOf(line: String): String? = UNTRACKED.find(line)?.groupValues?.get(1)?.trim()

    private fun wordsIn(reason: String) = reason.split(Regex("\\s+")).count { word -> word.any { it.isLetterOrDigit() } }

    /** How far above a dialog its `rememberTrackedDialog` may be. */
    private const val DIALOG_REACH = 40

    /** `ControlScan <sources> [analytics-v1.json]`: prints what lacks an id, and ids not in the catalogue. */
    @JvmStatic
    fun main(args: Array<String>) {
        val result = scan(File(args[0]))
        result.problems.forEach(::println)
        val catalogue = args.getOrNull(1)?.let { AnalyticsCatalogue.parse(File(it).readText()) }
        if (catalogue != null) {
            for (use in result.uses) if (!catalogue.has(use.kind, use.name)) println("${use.where}: ${use.kind} ${use.name} is not in the catalogue")
        }
        println("${result.controls} controls, ${result.dialogs} dialogs, ${result.problems.size} problems")
    }

    fun scan(root: File): Result {
        val problems = ArrayList<String>()
        val uses = ArrayList<Use>()
        var controls = 0
        var dialogs = 0
        var fields = 0
        val files = root.walkTopDown().filter { it.isFile && it.extension == "kt" }.sortedBy { it.path }.toList()
        for (file in files) {
            val text = file.readText()
            val source = Source(text)
            val name = file.relativeTo(root).path
            fun where(at: Int) = "$name:${source.line(at)}"

            fun check(at: Int, span: String, what: String) {
                controls++
                if (MARKERS.containsMatchIn(span)) return
                if (source.exempt(at)) return
                problems += "${where(at)}: $what has no tracked id or command"
            }

            // A call's own arguments: its content (`text = { … }`, the trailing `{ … }`) is not its marker.
            fun calls(pattern: Regex, each: (at: Int, args: String, name: String) -> Unit) {
                for (match in pattern.findAll(text)) {
                    val at = match.range.first
                    if (!source.code(at) || source.declared(at)) continue
                    val open = match.range.last
                    val close = source.close(open) ?: continue
                    each(at, source.ownArgs(open, close), match.groupValues[1])
                }
            }
            calls(CONTROLS) { at, args, what -> if (!NO_ACTION.containsMatchIn(args)) check(at, args, what) }
            calls(CLICKABLE_CONTAINERS) { at, args, what ->
                if (HAS_ON_CLICK.containsMatchIn(args) && !NO_ACTION.containsMatchIn(args)) check(at, args, what)
            }
            calls(BOXES) { at, args, what -> check(at, args, what) }
            calls(LINKS) { at, args, what -> check(at, args, "LinkAnnotation.$what") }
            calls(SLIDERS) { at, args, what ->
                controls++
                val finished = VALUE_FINISHED.find(args)
                val marked = finished != null && MARKERS.containsMatchIn(args.substring(finished.range.last + 1).let(source::firstArgument))
                if (!marked && !source.exempt(at)) problems += "${where(at)}: $what has no tracked onValueChangeFinished"
            }
            calls(WRAPPERS) { at, args, what ->
                controls++
                if (!EVENT_ARGS.containsMatchIn(args) && !source.exempt(at)) problems += "${where(at)}: $what has no event ="
            }
            for (match in POINTER_INPUT.findAll(text)) {
                val at = match.range.first
                if (!source.code(at)) continue
                val open = source.skipSpace(match.range.last + 1)
                if (open >= text.length || text[open] != '(') continue
                val close = source.close(open) ?: continue
                val body = source.skipSpace(close + 1)
                if (body >= text.length || text[body] != '{') continue
                val end = source.close(body) ?: continue
                val span = text.substring(at, end + 1)
                if (TAP_GESTURES.containsMatchIn(span)) check(at, span, "pointerInput tap gesture")
            }
            for (line in source.shortReasons()) problems += "$name:$line: `// untracked:` needs a reason of three words or more"
            for (match in MODIFIERS.findAll(text)) {
                val at = match.range.first
                if (!source.code(at)) continue
                var end = match.range.last
                var next = source.skipSpace(end + 1)
                var named = false
                if (next < text.length && text[next] == '(') {
                    val close = source.close(next) ?: continue
                    named = HAS_ON_CLICK.containsMatchIn(text.substring(next, close))
                    end = close
                    next = source.skipSpace(end + 1)
                }
                // The trailing `{ … }` is its onClick, unless it was named already.
                if (!named && next < text.length && text[next] == '{') end = source.close(next) ?: continue
                check(at, text.substring(at, end + 1), match.groupValues[1])
            }
            val tracked = DIALOG_CALLS.findAll(text).filter { source.code(it.range.first) }.map { it.range.first }.toList()
            val dialogSpans = ArrayList<IntRange>()
            for (match in DIALOGS.findAll(text)) {
                val at = match.range.first
                if (!source.code(at) || source.declared(at)) continue
                dialogs++
                val open = match.range.last
                val close = source.close(open) ?: continue
                var end = close
                val next = source.skipSpace(close + 1)
                if (next < text.length && text[next] == '{') end = source.close(next) ?: close
                dialogSpans += at..end
                val line = source.line(at)
                val near = tracked.any { it in at..end || (it < at && line - source.line(it) <= DIALOG_REACH) }
                if (!near && !source.exempt(at)) problems += "${where(at)}: ${match.groupValues[1]} is not tracked by name (rememberTrackedDialog)"
            }

            calls(TEXT_FIELDS) { at, args, what ->
                if (dialogSpans.none { at in it }) return@calls
                fields++
                if (!TYPED_LENGTH.containsMatchIn(args) && !source.exempt(at)) {
                    problems += "${where(at)}: $what in a dialog records no typed length (typedLength)"
                }
            }

            // The ids written as literals: a tracked call's first argument, a wrapper's `event =`,
            // and a dialog's name.
            fun literals(kind: String, from: Int) {
                val expression = source.argument(from)
                for (literal in source.literals(from, from + expression.length)) {
                    if (literal.second.contains('$')) {
                        problems += "${where(literal.first)}: \"${literal.second}\" is built from data"
                    } else {
                        uses += Use(kind, literal.second, where(literal.first))
                    }
                }
            }
            for (match in ID_CALLS.findAll(text)) {
                if (source.code(match.range.first) && !source.declared(match.range.first)) literals("click", match.range.last + 1)
            }
            for (match in EVENT_ARGS.findAll(text)) {
                if (source.code(match.range.first)) literals("click", match.range.last + 1)
            }
            for (match in DIALOG_CALLS.findAll(text)) {
                if (source.code(match.range.first) && !source.declared(match.range.first)) literals("dialog", match.range.last + 1)
            }
            // A typed length's dialog is an `input` name (PEN-177).
            for (match in TYPED_LENGTH.findAll(text)) {
                if (source.code(match.range.first) && !source.declared(match.range.first)) literals("input", match.range.last + 1)
            }
        }
        return Result(problems, uses, controls, dialogs, fields)
    }

    /** Kotlin source with what is code told from strings and comments. */
    class Source(private val text: String) {
        /** 0 code, 1 string, 2 comment. */
        private val kinds = ByteArray(text.length)

        /** How deep in string templates the reading is: a string inside one is the outer string's. */
        private var templates = 0
        private val lineStarts = ArrayList<Int>().apply {
            add(0)
            text.forEachIndexed { i, c -> if (c == '\n') add(i + 1) }
        }

        init {
            code(0, null)
        }

        /** Whether [at] is code, outside the imports. */
        fun code(at: Int) = kinds[at] == CODE && !lineText(line(at)).startsWith("import ")

        fun line(at: Int): Int {
            var low = 0
            var high = lineStarts.size - 1
            while (low < high) {
                val mid = (low + high + 1) / 2
                if (lineStarts[mid] <= at) low = mid else high = mid - 1
            }
            return low + 1
        }

        private fun lineText(line: Int): String {
            if (line < 1 || line > lineStarts.size) return ""
            val start = lineStarts[line - 1]
            val end = if (line < lineStarts.size) lineStarts[line] else text.length
            return text.substring(start, end)
        }

        /** An `// untracked: <why>` comment, its why three words or more, on the line or the one above. */
        fun exempt(at: Int): Boolean {
            val line = line(at)
            return listOf(line, line - 1).any { n -> reasonOf(lineText(n))?.let { wordsIn(it) >= REASON_WORDS } == true }
        }

        /** The lines (1-based) whose `// untracked:` comment gives fewer than three words of why. */
        fun shortReasons(): List<Int> = (1..lineStarts.size).filter { n ->
            val text = lineText(n)
            val reason = reasonOf(text) ?: return@filter false
            val at = lineStarts[n - 1] + text.indexOf("untracked:")
            kinds[at] == COMMENT && wordsIn(reason) < REASON_WORDS
        }

        /**
         * The call's own arguments, `(` at [open] to `)` at [close], with each named lambda that is
         * its content (`text = { … }`, `icon = { … }`) blanked: a marker there is not the control's.
         */
        fun ownArgs(open: Int, close: Int): String {
            val own = StringBuilder()
            var from = open + 1
            while (from < close) {
                val argument = argument(from)
                val name = CONTENT_ARG.find(argument)?.groupValues?.get(1)
                if (name == null || ACTION_ARG.matches(name)) own.append(argument)
                own.append(',')
                from += argument.length + 1
            }
            return "(" + own + ")"
        }

        /** Whether the name at [at] is being declared (`fun TextButton(`), not called. */
        fun declared(at: Int): Boolean {
            var i = at - 1
            // `fun Modifier.tracked(`: walk back over the receiver.
            if (i >= 0 && text[i] == '.') {
                while (i >= 0 && (text[i].isLetterOrDigit() || text[i] == '.' || text[i] == '_')) i--
            }
            while (i >= 0 && text[i] == ' ') i--
            // `fun <T> Options(`: walk back over the type parameters.
            if (i >= 0 && text[i] == '>') {
                while (i >= 0 && text[i] != '<') i--
                i--
                while (i >= 0 && text[i] == ' ') i--
            }
            return i >= 2 && text.substring(maxOf(0, i - 2), i + 1) == "fun"
        }

        fun skipSpace(from: Int): Int {
            var i = from
            while (i < text.length && (text[i].isWhitespace() || kinds[i] == COMMENT)) i++
            return i
        }

        /** The index of the bracket that closes the one at [open], counting only code. */
        fun close(open: Int): Int? {
            val opening = text[open]
            val closing = if (opening == '(') ')' else if (opening == '{') '}' else ']'
            var depth = 0
            for (i in open until text.length) {
                if (kinds[i] != CODE) continue
                val c = text[i]
                if (c == '(' || c == '{' || c == '[') depth++
                if (c == ')' || c == '}' || c == ']') {
                    depth--
                    if (depth == 0) return if (c == closing) i else null
                }
            }
            return null
        }

        /** The argument starting at [from]: up to its top-level comma or the call's close. */
        fun argument(from: Int): String {
            var depth = 0
            for (i in from until text.length) {
                if (kinds[i] != CODE) continue
                when (text[i]) {
                    '(', '{', '[' -> depth++
                    ')', '}', ']' -> if (depth == 0) return text.substring(from, i) else depth--
                    ',' -> if (depth == 0) return text.substring(from, i)
                }
            }
            return text.substring(from)
        }

        /** [args] (a call's arguments from just after a `name =`) up to that argument's end. */
        fun firstArgument(args: String): String {
            var depth = 0
            for ((i, c) in args.withIndex()) {
                when (c) {
                    '(', '{', '[' -> depth++
                    ')', '}', ']' -> if (depth == 0) return args.substring(0, i) else depth--
                    ',' -> if (depth == 0) return args.substring(0, i)
                }
            }
            return args
        }

        /** The plain string literals that start in [from]..<[to], with where each starts. */
        fun literals(from: Int, to: Int): List<Pair<Int, String>> {
            val found = ArrayList<Pair<Int, String>>()
            var i = from
            while (i < to) {
                if (kinds[i] == CODE && text[i] == '"' && !text.startsWith("\"\"\"", i)) {
                    var j = i + 1
                    while (j < text.length && kinds[j] == STRING) j++
                    found += i to text.substring(i + 1, j)
                    i = j + 1
                } else {
                    i++
                }
            }
            return found
        }

        /** Marks code from [start] until the `}` that closes a template (when [inTemplate]); returns the index after it. */
        private fun code(start: Int, inTemplate: Boolean?): Int {
            var i = start
            var depth = 0
            while (i < text.length) {
                val c = text[i]
                when {
                    text.startsWith("//", i) -> {
                        while (i < text.length && text[i] != '\n') kinds[i++] = COMMENT
                    }
                    text.startsWith("/*", i) -> i = comment(i)
                    text.startsWith("\"\"\"", i) -> i = string(i, raw = true)
                    c == '"' -> i = string(i, raw = false)
                    c == '\'' -> {
                        kinds[i] = CODE
                        var j = i + 1
                        while (j < text.length && text[j] != '\'' && text[j] != '\n') {
                            if (text[j] == '\\') j++
                            j++
                        }
                        for (k in i + 1 until minOf(j, text.length)) kinds[k] = STRING
                        if (j < text.length) kinds[j] = CODE
                        i = j + 1
                    }
                    else -> {
                        kinds[i] = if (inTemplate == true) STRING else CODE
                        if (c == '{') depth++
                        if (c == '}') {
                            if (inTemplate == true && depth == 0) return i + 1
                            depth--
                        }
                        i++
                    }
                }
            }
            return i
        }

        private fun comment(start: Int): Int {
            var i = start
            var depth = 0
            while (i < text.length) {
                if (text.startsWith("/*", i)) {
                    depth++
                    kinds[i] = COMMENT
                    kinds[i + 1] = COMMENT
                    i += 2
                } else if (text.startsWith("*/", i)) {
                    depth--
                    kinds[i] = COMMENT
                    kinds[i + 1] = COMMENT
                    i += 2
                    if (depth == 0) return i
                } else {
                    kinds[i++] = COMMENT
                }
            }
            return i
        }

        /** A string from its opening quote; its templates' code counts as string too. Returns the index after it. */
        private fun string(start: Int, raw: Boolean): Int {
            val quote = if (raw) 3 else 1
            val edge = if (templates > 0) STRING else CODE
            kinds[start] = edge
            var i = start + quote
            while (i < text.length) {
                if (raw && text.startsWith("\"\"\"", i)) {
                    // A raw string ends at its last run of quotes.
                    var end = i + 3
                    while (end < text.length && text[end] == '"') end++
                    for (k in i until end - 3) kinds[k] = STRING
                    for (k in end - 3 until end) kinds[k] = edge
                    return end
                }
                if (!raw && text[i] == '"') {
                    kinds[i] = edge
                    return i + 1
                }
                if (!raw && text[i] == '\\') {
                    kinds[i] = STRING
                    if (i + 1 < text.length) kinds[i + 1] = STRING
                    i += 2
                    continue
                }
                if (text.startsWith("\${", i)) {
                    kinds[i] = STRING
                    kinds[i + 1] = STRING
                    templates++
                    i = code(i + 2, inTemplate = true)
                    templates--
                    continue
                }
                kinds[i++] = STRING
            }
            return i
        }

        private companion object {
            const val CODE: Byte = 0
            const val STRING: Byte = 1
            const val COMMENT: Byte = 2
        }
    }
}
