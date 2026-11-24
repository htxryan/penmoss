package app.penmoss.ui.home

import android.content.Context
import app.penmoss.engine.settings.JokeDeck

/**
 * Where Home's dad-joke deck is kept (PEN-10): this phone's own preferences, under the web's key,
 * as the Mac keeps its deck in its own storage (A1576). Never synced: each device deals its own.
 */
internal object HomeJokes {
    private const val FILE = "penmoss.ui"

    fun store(context: Context): JokeDeck.Store {
        val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        return object : JokeDeck.Store {
            override fun read(): String? = prefs.getString(JokeDeck.KEY, null)
            override fun write(deck: String) {
                prefs.edit().putString(JokeDeck.KEY, deck).apply()
            }
        }
    }
}
