package app.penmoss

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import kotlin.math.hypot

/**
 * The launcher icon (A402, docs/brand.md): the Moss Pen mark as an adaptive icon, with a
 * monochrome layer for themed icons, drawn inside the safe zone so no launcher mask cuts it.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LauncherIconTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun icon(id: Int) = context.getDrawable(id) as AdaptiveIconDrawable

    /** Draws [layer] at one pixel per dp of its 108 dp square. */
    private fun pixels(layer: Drawable): Bitmap {
        val bitmap = Bitmap.createBitmap(108, 108, Bitmap.Config.ARGB_8888)
        layer.setBounds(0, 0, 108, 108)
        layer.draw(Canvas(bitmap))
        return bitmap
    }

    @Test
    fun theAppAndRoundIconsAreAdaptiveWithAMonochromeLayer() {
        val app = context.packageManager.getApplicationInfo(context.packageName, 0)
        assertEquals(R.mipmap.ic_launcher, app.icon)
        for (id in listOf(R.mipmap.ic_launcher, R.mipmap.ic_launcher_round)) {
            val icon = icon(id)
            assertEquals(context.getColor(R.color.ic_launcher_background), (icon.background as ColorDrawable).color)
            assertNotNull(icon.foreground)
            assertNotNull(icon.monochrome)
        }
    }

    @Test
    fun theMarkStaysInsideTheSafeZone() {
        val icon = icon(R.mipmap.ic_launcher)
        for ((name, layer) in listOf("foreground" to icon.foreground, "monochrome" to icon.monochrome!!)) {
            val bitmap = pixels(layer)
            var drawn = 0
            for (y in 0 until 108) {
                for (x in 0 until 108) {
                    if (Color.alpha(bitmap.getPixel(x, y)) == 0) continue
                    drawn++
                    // The safe zone is the 66 dp circle in the middle of the 108 dp layer.
                    val distance = hypot(x + 0.5 - 54, y + 0.5 - 54)
                    assertTrue("$name draws at ($x, $y), $distance dp from the centre", distance <= 33)
                }
            }
            // The fence and the moss cover about 700 of the layer's pixels.
            assertTrue("$name draws $drawn pixels", drawn > 500)
        }
    }

    @Test
    fun theMonochromeLayerIsTheSameShapeAsTheForeground() {
        val icon = icon(R.mipmap.ic_launcher)
        val foreground = pixels(icon.foreground)
        val monochrome = pixels(icon.monochrome!!)
        for (y in 0 until 108) {
            for (x in 0 until 108) {
                assertEquals("alpha at ($x, $y)", Color.alpha(foreground.getPixel(x, y)), Color.alpha(monochrome.getPixel(x, y)))
            }
        }
    }
}
