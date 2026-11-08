package app.penmoss.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.engine.settings.LineSymbol
import app.penmoss.engine.settings.LineSymbols
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.settings.SymbolsScreen

/*
 * Settings → Symbols on the phone (T44, ST13, A747): the web's synced `symbols.list`, the line
 * symbols a note's Symbol menu offers and its margin draws. Up to nine, one per shortcut slot
 * (a hardware keyboard's Alt+Shift+1–9), each a glyph, a name and a theme colour. Changing the
 * list never changes a note: a glyph taken off it shows as text again (A742).
 */

/** What the Settings home says of Symbols: the glyphs, in order. */
fun symbolsSummary(settings: Settings): String {
    val symbols = settings.symbols
    return if (symbols.isEmpty()) "None" else symbols.joinToString(" ") { it.glyph }
}

/** A change to the list, before it is sent: its problem by the web's rules, or null. */
internal fun symbolsChange(symbols: List<LineSymbol>): String? = LineSymbols.listProblem(symbols)

@Composable
internal fun SymbolsRoute(graph: AppGraph, onShortcuts: () -> Unit, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    SymbolsScreen(
        symbols = state.settings.symbols,
        custom = state.settings.customSymbols,
        enabled = state.known,
        onChange = { next ->
            val problem = symbolsChange(next)
            if (problem == null) graph.changeSetting(SettingKeys.SYMBOLS, LineSymbols.toJson(next))
            problem
        },
        // Restore defaults clears the setting, as the web's does.
        onReset = { graph.changeSetting(SettingKeys.SYMBOLS, null) },
        onShortcuts = onShortcuts,
        onBack = onBack,
    )
}
