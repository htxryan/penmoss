package app.penmoss.spike

/**
 * The paragraph typed in every keyboard session. Must match TEST_PARAGRAPH in
 * web/src/consistency.ts; the instrumentation test asserts they are equal.
 */
const val TEST_PARAGRAPH =
    "The quick brown fox jumps over the lazy dog while Ryan's kettle boils. " +
        "On Tuesday at 7:45 we packed 3 boxes, 12 books and a lamp; nothing broke! " +
        "Is this editor really fast enough for long writing on a phone? " +
        "Let's find out, one sentence at a time, without fixing anything by hand."

/** Labels for typing tests; the current IME package is appended automatically. */
val KEYBOARD_MODES = listOf(
    "Gboard tap",
    "Gboard swipe",
    "Gboard autocorrect",
    "Gboard voice",
    "Alternative keyboard",
    "Free writing",
)

/** Short form of the protocol in spikes/android-editor/README.md (the README is canonical). */
val PROTOCOL_STEPS = listOf(
    "Cold open: force-stop the app, open it, and read \"Opened in … ms\" under the title. Repeat 3 times. Target: under 1000 ms.",
    "Scroll: turn on Developer options → Profile HWUI rendering → On screen as bars. Fling through the whole note top to bottom and back. Bars should stay under the green 60 fps line. Then open Stats and note the frame numbers.",
    "Per keyboard (Gboard tap, swipe, autocorrect on, voice; then one alternative keyboard), spend about 15 minutes: start a typing test below, type the test paragraph exactly, tap Check, and note the result. Then keep writing freely in the note.",
    "In each session, exercise Enter and Backspace: inside and at the end of bullet lists and checklists, at the start and end of code blocks, and directly before and after an image. Note any misfire.",
    "Caret: put the caret near the bottom of the note, open the keyboard and type several lines. The caret must stay visible above the formatting bar.",
    "Formatting bar: try every button while typing. The keyboard should stay open.",
    "Real note: write a real note of at least 500 words and rate the feel against Google Keep and Notion (1–5).",
    "Export log after each keyboard session (Share file) and send the files back with your notes and screen recordings.",
)
