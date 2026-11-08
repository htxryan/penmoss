package app.penmoss.editor

import app.penmoss.engine.bridge.WebPictureMode
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Dns
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.InetAddress

/**
 * Pictures from web addresses (T40 P8, ED13), fetched by the phone: https only, public addresses
 * only (after DNS and for every redirect), no cookies or token, a picture type sniffed, 20 MB at
 * most, cached within 200 MB, and never an exception (A312). MockWebServer speaks plain http on
 * loopback, so the tests that fetch let http and loopback through; the refusals use the real rules.
 */
class RemotePicturesTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.close()

    private fun onLoopback(maxBytes: Int = RemotePictures.MAX_BYTES, maxCache: Long = RemotePictures.MAX_CACHE_BYTES) =
        RemotePictures(
            folder.newFolder(),
            allowed = { it.isLoopbackAddress || RemotePictures.isPublic(it) },
            allowHttp = true,
            maxBytes = maxBytes,
            maxCacheBytes = maxCache,
        )

    private fun picture(bytes: ByteArray = png, type: String = "text/html") =
        MockResponse.Builder().code(200).addHeader("Content-Type", type).body(okio.Buffer().write(bytes)).build()

    @Test
    fun fetchesAPictureWithNoCookiesOrTokenAndKeepsIt() {
        val pictures = onLoopback()
        // The server's type is not believed: the bytes say it is a PNG.
        server.enqueue(picture())
        val address = server.url("/cat?size=2").toString()
        val (file, ext) = pictures.fileFor(address)!!
        assertEquals("png", ext)
        assertArrayEquals(png, file.readBytes())
        val request = server.takeRequest()
        assertNull(request.headers["Cookie"])
        assertNull(request.headers["Authorization"])
        assertEquals("image/*", request.headers["Accept"])
        // Kept: shown again without asking.
        assertEquals(file, pictures.fileFor(address)!!.first)
        assertEquals(1, server.requestCount)
        assertEquals(png.size.toLong(), pictures.bytesUsed())
        pictures.clear()
        assertEquals(0L, pictures.bytesUsed())
    }

    @Test
    fun refusesWhatIsNotAPictureOrIsTooLarge() {
        val pictures = onLoopback(maxBytes = 8)
        server.enqueue(picture("<svg onload=alert(1)>".toByteArray(), "image/svg+xml"))
        assertNull(pictures.fileFor(server.url("/svg").toString()))
        server.enqueue(picture())
        assertNull(pictures.fileFor(server.url("/big").toString()))
        server.enqueue(MockResponse.Builder().code(404).build())
        assertNull(pictures.fileFor(server.url("/gone").toString()))
        assertEquals(0L, pictures.bytesUsed())
    }

    @Test
    fun onlyHttpsAndPublicAddressesWithTheRealRules() {
        val pictures = RemotePictures(folder.newFolder())
        for (address in listOf(
            "http://example.com/a.png",
            "ftp://example.com/a.png",
            "https://127.0.0.1/a.png",
            "https://10.0.0.8/a.png",
            "https://192.168.1.1/a.png",
            "https://172.20.0.1/a.png",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/a.png",
            "https://[::1]/a.png",
            "https://[fd00::1]/a.png",
            "https://[fe80::1]/a.png",
            "https://[::ffff:192.168.1.1]/a.png",
            "https://user:pass@example.com/a.png",
            "https://example.com/" + "a".repeat(RemotePictures.MAX_ADDRESS),
            "not a url",
        )) {
            assertNull(address, pictures.checked(address))
            assertNull(address, pictures.fileFor(address))
        }
        assertEquals("https://example.com/a.png", pictures.checked("https://example.com/a.png").toString())
        assertEquals("https://93.184.216.34/a.png", pictures.checked("https://93.184.216.34/a.png").toString())
    }

    /** A name for this machine (where MockWebServer listens): what a rebinding DNS answers. */
    private val onThisMachine = Dns { host -> listOf(InetAddress.getByAddress(host, byteArrayOf(127, 0, 0, 1))) }

    @Test
    fun aNameThatResolvesToTheHomeNetworkIsNeverReached() {
        // DNS rebinding and names for private addresses: checked after the lookup, by the real rules.
        val pictures = RemotePictures(folder.newFolder(), dns = onThisMachine, allowHttp = true)
        server.enqueue(picture())
        assertNull(pictures.fileFor("http://router.example:${server.port}/admin.png"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun anAddressInTheUrlIsCheckedThoughItSkipsDns() {
        val pictures = RemotePictures(folder.newFolder(), allowHttp = true)
        server.enqueue(picture())
        assertNull(pictures.fileFor("http://127.0.0.1:${server.port}/a.png"))
        // Short forms OkHttp connects to without DNS (review PB1): 127.1 and 2130706433 are 127.0.0.1.
        assertNull(pictures.fileFor("http://127.1:${server.port}/a.png"))
        assertNull(pictures.fileFor("http://2130706433:${server.port}/a.png"))
        assertNull(pictures.fileFor("http://0177.0.0.1:${server.port}/a.png"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun anAddressInAShortOctalHexOrIpv6FormIsRefusedToo() {
        val pictures = RemotePictures(folder.newFolder())
        for (address in listOf(
            "https://127.1/a.png",
            "https://2130706433/a.png",
            "https://10.1/a.png",
            "https://3232235777/a.png",
            "https://192.168.1/a.png",
            "https://0x7f.1/a.png",
            "https://0x7f000001/a.png",
            "https://0177.0.0.1/a.png",
            "https://127.0.0.01/a.png",
            "https://127.0.0.1./a.png",
            "https://1572395042/a.png",
            "https://[::1]/a.png",
            "https://[::ffff:127.0.0.1]/a.png",
            "https://[::ffff:7f00:1]/a.png",
            "https://[fd00::1]/a.png",
            "https://[64:ff9b:1::a00:1]/a.png",
            "https://[2002:c0a8:101::1]/a.png",
        )) {
            assertNull(address, pictures.checked(address))
        }
        // Names that merely start with a number, and a plain public quad, are still fetched.
        assertEquals("https://1password.example/a.png", pictures.checked("https://1password.example/a.png").toString())
        assertEquals("https://0x7f.example/a.png", pictures.checked("https://0x7f.example/a.png").toString())
        assertEquals("https://8.8.8.8/a.png", pictures.checked("https://8.8.8.8/a.png").toString())
        assertEquals("https://[2606:4700::1111]/a.png", pictures.checked("https://[2606:4700::1111]/a.png").toString())
    }

    @Test
    fun checksEveryRedirectAgain() {
        // Only the name may be reached: the machine's address in a redirect may not.
        val named = RemotePictures(
            folder.newFolder(),
            dns = onThisMachine,
            allowed = { it.isLoopbackAddress && it.hostName == "public.example" },
            allowHttp = true,
        )
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "http://127.0.0.1:${server.port}/inside.png").build())
        server.enqueue(picture())
        assertNull(named.fileFor("http://public.example:${server.port}/out"))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun followsAFewRedirectsOnly() {
        val pictures = onLoopback()
        server.enqueue(MockResponse.Builder().code(301).addHeader("Location", "/real.png").build())
        server.enqueue(picture())
        assertEquals("png", pictures.fileFor(server.url("/moved").toString())!!.second)
        server.takeRequest()
        assertEquals("/real.png", server.takeRequest().url.encodedPath)

        repeat(RemotePictures.MAX_REDIRECTS + 1) {
            server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/loop").build())
        }
        assertNull(pictures.fileFor(server.url("/loop").toString()))
    }

    @Test
    fun keepsTheCacheWithinItsSizeDroppingTheLeastRecentlyShown() {
        val pictures = onLoopback(maxCache = png.size * 2L)
        val first = server.url("/1").toString()
        repeat(3) { server.enqueue(picture(png + byteArrayOf(it.toByte()))) }
        val one = pictures.fileFor(first)!!.first
        one.setLastModified(1_000)
        pictures.fileFor(server.url("/2").toString())
        pictures.fileFor(server.url("/3").toString())
        assertFalse(one.exists())
        assertTrue(pictures.bytesUsed() <= png.size * 2L + 2)
    }

    @Test
    fun neverThrows() {
        val pictures = onLoopback()
        server.close()
        assertNull(pictures.fileFor("http://127.0.0.1:1/a.png"))
        val failing = RemotePictures(folder.newFolder(), dns = { throw IllegalStateException("broken") })
        assertNull(failing.fileFor("https://example.com/a.png"))
    }

    @Test
    fun theSettingDecidesAndWiFiOnlyWaitsForATapOnMobileData() {
        assertEquals(WebPictureMode.ON, WebPictureSetting.ON.mode(metered = true))
        assertEquals(WebPictureMode.WAIT, WebPictureSetting.WIFI_ONLY.mode(metered = true))
        assertEquals(WebPictureMode.ON, WebPictureSetting.WIFI_ONLY.mode(metered = false))
        assertEquals(WebPictureMode.OFF, WebPictureSetting.OFF.mode(metered = false))
        assertFalse(WebPictureSetting.WIFI_ONLY.allows(metered = true, tapped = false))
        assertTrue(WebPictureSetting.WIFI_ONLY.allows(metered = true, tapped = true))
        // Off is off, even for a page that says it was tapped.
        assertFalse(WebPictureSetting.OFF.allows(metered = false, tapped = true))
        // On by default, as the web shows them.
        assertEquals(WebPictureSetting.ON, WebPictureSetting.of(null))
        assertEquals(WebPictureSetting.WIFI_ONLY, WebPictureSetting.of("wifi"))
    }

    @Test
    fun judgesAddressesAsPublicOrNot() {
        fun public(text: String) = RemotePictures.isPublic(InetAddress.getByName(text))
        assertTrue(public("93.184.216.34"))
        assertTrue(public("2606:2800:220:1:248:1893:25c8:1946"))
        for (inside in listOf("0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.1.1", "100.100.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1")) {
            assertFalse(inside, public(inside))
        }
        assertTrue(public("::ffff:93.184.216.34"))
    }
}
