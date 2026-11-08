package app.penmoss.ui

import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import android.content.Context
import android.provider.Settings
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.Composable
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost

/** How long a screen takes to slide in or out (A351). */
internal const val NAV_MS = 300

/**
 * The app's NavHost (A351): screens slide sideways like the rest of Android, and Back (including
 * predictive back) slides the screen off to the end. Navigation's default fade and scale read as
 * a shrink. Shared with the tests, so they drive the real transitions (T40 P5 review B1).
 */
@Composable
internal fun PenmossNavHost(nav: NavHostController, startDestination: String, builder: NavGraphBuilder.() -> Unit) {
    // With Remove animations on (Accessibility, or animations off in Developer options), screens
    // change at once instead of sliding (T40 P9, PL14, A498).
    if (reducedMotion(LocalContext.current)) {
        NavHost(
            nav,
            startDestination = startDestination,
            enterTransition = { EnterTransition.None },
            exitTransition = { ExitTransition.None },
            popEnterTransition = { EnterTransition.None },
            popExitTransition = { ExitTransition.None },
            builder = builder,
        )
        return
    }
    NavHost(
        nav,
        startDestination = startDestination,
        enterTransition = { slideIntoContainer(SlideDirection.Start, tween(NAV_MS)) },
        exitTransition = { slideOutOfContainer(SlideDirection.Start, tween(NAV_MS)) { it / 4 } },
        popEnterTransition = { slideIntoContainer(SlideDirection.End, tween(NAV_MS)) { it / 4 } },
        popExitTransition = { slideOutOfContainer(SlideDirection.End, tween(NAV_MS)) },
        builder = builder,
    )
}

/** Whether the phone asks for no motion: its animator scale is 0 (Remove animations). */
internal fun reducedMotion(context: Context): Boolean =
    runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
        .getOrDefault(false)

/**
 * The periodic screen [entry] made its note (T40 P5): the note's screen replaces it in one step.
 * Popping first and then opening drops the open, since the screen revealed is still sliding in
 * and not yet resumed (A387's guard), so the note never showed. Only while [entry] is still in
 * front: a note made after Back was pressed opens nothing and pops nothing. True when it opened.
 */
internal fun NavHostController.replaceWithNote(entry: NavBackStackEntry, noteId: String): Boolean {
    if (currentBackStackEntry != entry) return false
    navigate("note/$noteId") { popUpTo(entry.destination.id) { inclusive = true } }
    return true
}
