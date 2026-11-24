package app.penmoss.ui.common

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import app.penmoss.analytics.trackedClick

/** A top app bar's back arrow, recorded as `nav.back` (A1635): every screen's, so they never drift. */
@Composable
fun BackButton(onBack: () -> Unit) {
    IconButton(onClick = trackedClick("nav.back", onBack)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
}
