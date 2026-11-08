package app.penmoss.editor

import android.content.SharedPreferences
import app.penmoss.data.Attachments
import app.penmoss.engine.bridge.WebPictureMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/**
 * Pictures from web addresses in a note (T40 P8, ED13). The editor page asks for them on its own
 * origin (`/remote?u=<address>`, its CSP still reaching nothing else, A293) and the editor's
 * WebView answers from here. A web picture tells its host the note was opened, as it does on
 * the web; the rest is guarded:
 *
 * - `https` only, with the system's certificate authorities;
 * - public addresses only, checked after DNS (no private, loopback, link-local or carrier
 *   addresses: a note must not reach into the home network), for every redirect too;
 * - no cookies and no token: nothing of the account goes with it;
 * - a picture type sniffed from the bytes (never the server's word), 20 MB at most;
 * - kept in a disk cache of 200 MB, the least recently shown going first.
 *
 * [fileFor] never throws (A312): an exception on a WebView request thread would end the app.
 */
class RemotePictures(
    private val cache: File,
    /** Where names resolve; only public addresses are used from what it answers. */
    dns: Dns = Dns.SYSTEM,
    /** Which addresses may be fetched from: public ones (tests let loopback through). */
    private val allowed: (InetAddress) -> Boolean = ::isPublic,
    /** Tests only: MockWebServer speaks plain http. */
    private val allowHttp: Boolean = false,
    private val maxBytes: Int = MAX_BYTES,
    private val maxCacheBytes: Long = MAX_CACHE_BYTES,
    client: OkHttpClient? = null,
) {
    private val vetted = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            val public = dns.lookup(hostname).filter(allowed)
            if (public.isEmpty()) throw UnknownHostException("$hostname has no public address")
            return public
        }
    }

    private val http: OkHttpClient = (client?.newBuilder() ?: OkHttpClient.Builder())
        .dns(vetted)
        // No proxy: a proxy would resolve the name itself, past the address rules.
        .proxy(Proxy.NO_PROXY)
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        // Each hop is checked here before it is followed.
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    /** At most two fetches at once: a note naming many pictures must not take every request thread. */
    private val fetching = Semaphore(MAX_FETCHES)

    /** One fetch per address: other requests for it wait for that one. */
    private val locks = ConcurrentHashMap<String, Any>()

    /** The picture at [address] and its extension, from the cache or fetched; null when it cannot be had. */
    fun fileFor(address: String): Pair<File, String>? = try {
        val url = checked(address)
        if (url == null) {
            null
        } else {
            val key = keyOf(url.toString())
            val lock = locks.computeIfAbsent(key) { Any() }
            synchronized(lock) {
                try {
                    cached(key) ?: fetch(url, key)
                } finally {
                    locks.remove(key, lock)
                }
            }
        }
    } catch (error: Exception) {
        null
    }

    /** The bytes the cache holds on this phone, for Settings → Sync and storage. */
    fun bytesUsed(): Long = cache.listFiles()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L

    /** Forgets every picture fetched (Settings, or the cache cleared for another account). */
    fun clear() {
        cache.listFiles()?.forEach { it.delete() }
    }

    /** The address as a URL this may fetch, or null: https (and a public host when it is an address). */
    fun checked(address: String): HttpUrl? {
        if (address.length > MAX_ADDRESS) return null
        val url = address.toHttpUrlOrNull() ?: return null
        if (url.scheme != "https" && !(allowHttp && url.scheme == "http")) return null
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
        // An address in the URL skips DNS, so it is checked here (review PB1): OkHttp takes any
        // digits-and-dots host as an address and connects to what the system makes of it, which
        // reads `127.1`, `2130706433` and octal parts as addresses too. Only a plain dotted quad
        // is taken; every other numeric form is refused.
        when (val host = hostKind(url.host)) {
            HostKind.Name -> Unit
            HostKind.Refused -> return null
            is HostKind.Address -> if (!allowed(host.address)) return null
        }
        return url
    }

    private fun cached(key: String): Pair<File, String>? {
        for (ext in Attachments.TYPES.keys) {
            val file = File(cache, "$key.$ext")
            if (file.isFile) {
                file.setLastModified(System.currentTimeMillis())
                return file to ext
            }
        }
        return null
    }

    private fun fetch(first: HttpUrl, key: String): Pair<File, String>? {
        fetching.acquire()
        try {
            var url = first
            repeat(MAX_REDIRECTS + 1) {
                val request = Request.Builder().url(url).header("Accept", "image/*").get().build()
                http.newCall(request).execute().use { response ->
                    if (response.isRedirect) {
                        val location = response.header("Location") ?: return null
                        url = checked(url.resolve(location)?.toString() ?: return null) ?: return null
                        return@repeat
                    }
                    if (response.code != 200) return null
                    val declared = response.body.contentLength()
                    if (declared > maxBytes) return null
                    val bytes = readAtMost(response.body.byteStream(), maxBytes + 1)
                    if (bytes.size > maxBytes) return null
                    val ext = Attachments.sniff(bytes) ?: return null
                    return store(key, ext, bytes)
                }
            }
            return null
        } catch (error: IOException) {
            return null
        } finally {
            fetching.release()
        }
    }

    private fun store(key: String, ext: String, bytes: ByteArray): Pair<File, String>? {
        cache.mkdirs()
        val file = File(cache, "$key.$ext")
        val partial = File.createTempFile(key, ".part", cache)
        try {
            partial.writeBytes(bytes)
            if (!partial.renameTo(file) && !file.isFile) return null
        } finally {
            partial.delete()
        }
        trim(keep = file)
        return file to ext
    }

    /** Keeps the cache within its size, the least recently shown pictures going first. */
    private fun trim(keep: File) {
        val files = cache.listFiles()?.filter { it.isFile && !it.name.endsWith(".part") } ?: return
        var total = files.sumOf { it.length() }
        for (file in files.sortedBy { it.lastModified() }) {
            if (total <= maxCacheBytes) break
            if (file == keep) continue
            total -= file.length()
            file.delete()
        }
    }

    private fun readAtMost(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (out.size() < limit) {
            val read = input.read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (read < 0) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    companion object {
        /** The largest picture fetched from the web. */
        const val MAX_BYTES = 20 * 1024 * 1024

        /** The most the cache keeps on the phone. */
        const val MAX_CACHE_BYTES = 200L * 1024 * 1024

        /** The longest address fetched (the page's own limit). */
        const val MAX_ADDRESS = 4096

        const val MAX_REDIRECTS = 5
        private const val MAX_FETCHES = 2

        private fun keyOf(url: String): String =
            MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }

        private val NUMERIC_LABEL = Regex("^(\\d+|0[xX][0-9a-fA-F]*)$")
        private val QUAD_PART = Regex("^(0|[1-9]\\d{0,2})$")

        /**
         * What a URL's host is, without a DNS lookup: a name, an address (`93.184.216.34`,
         * `[::1]`), or a numeric form refused outright. A host OkHttp would connect to as an
         * address (digits and dots, or a colon), or one whose every label is a number (`0x7f.1`),
         * is an address only when it is a plain dotted quad or an IPv6 address.
         */
        internal fun hostKind(host: String): HostKind {
            val bare = host.removePrefix("[").removeSuffix("]")
            if (':' in bare) {
                return try {
                    HostKind.Address(InetAddress.getByName(bare))
                } catch (error: UnknownHostException) {
                    HostKind.Refused
                }
            }
            val labels = bare.split('.')
            val numeric = bare.all { it.isDigit() || it == '.' } || labels.all(NUMERIC_LABEL::matches)
            if (!numeric) return HostKind.Name
            if (labels.size != 4 || !labels.all { QUAD_PART.matches(it) && it.toInt() <= 255 }) return HostKind.Refused
            return HostKind.Address(InetAddress.getByAddress(ByteArray(4) { labels[it].toInt().toByte() }))
        }

        /**
         * Whether an address is on the public internet: not this phone, not the home network,
         * not link-local, carrier-grade NAT, multicast or reserved. An IPv6 address that carries
         * an IPv4 one (mapped, NAT64) is judged by that address.
         */
        fun isPublic(address: InetAddress): Boolean {
            if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
                address.isSiteLocalAddress || address.isMulticastAddress
            ) {
                return false
            }
            val bytes = address.address
            return when (address) {
                is Inet4Address -> isPublicV4(bytes)
                is Inet6Address -> isPublicV6(bytes)
                else -> false
            }
        }

        private fun isPublicV4(b: ByteArray): Boolean {
            val a = b[0].toInt() and 0xff
            val second = b[1].toInt() and 0xff
            return when {
                a == 0 || a == 10 || a == 127 -> false
                a == 100 && second in 64..127 -> false // Carrier-grade NAT.
                a == 169 && second == 254 -> false
                a == 172 && second in 16..31 -> false
                a == 192 && second == 168 -> false
                a == 192 && second == 0 && (b[2].toInt() and 0xff) == 0 -> false
                a == 198 && second in 18..19 -> false // Benchmarking.
                a >= 224 -> false // Multicast and reserved.
                else -> true
            }
        }

        private fun isPublicV6(b: ByteArray): Boolean {
            val first = b[0].toInt() and 0xff
            // Unique local (fc00::/7) and link-local (fe80::/10) addresses are the home network's.
            if (first and 0xfe == 0xfc || (first == 0xfe && (b[1].toInt() and 0xc0) == 0x80)) return false
            val zeros = (0 until 10).all { b[it].toInt() == 0 }
            // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the IPv4 address decides.
            if (zeros && ((b[10].toInt() and 0xff) == 0xff && (b[11].toInt() and 0xff) == 0xff)) return isPublicV4(b.copyOfRange(12, 16))
            if (zeros && b[10].toInt() == 0 && b[11].toInt() == 0) return false
            // 64:ff9b::/96 (NAT64): the IPv4 address it carries decides.
            val nat64 = byteArrayOf(0, 0x64, 0xff.toByte(), 0x9b.toByte(), 0, 0, 0, 0, 0, 0, 0, 0)
            if ((0 until 12).all { b[it] == nat64[it] }) return isPublicV4(b.copyOfRange(12, 16))
            // 64:ff9b:1::/48 (local-use NAT64) is a network's own; 2002::/16 (6to4) carries the
            // IPv4 address it reaches.
            if (b[0].toInt() == 0 && (b[1].toInt() and 0xff) == 0x64 && (b[2].toInt() and 0xff) == 0xff &&
                (b[3].toInt() and 0xff) == 0x9b && b[4].toInt() == 0 && b[5].toInt() == 1
            ) {
                return false
            }
            if (first == 0x20 && b[1].toInt() == 0x02) return isPublicV4(b.copyOfRange(2, 6))
            // 2001:db8::/32 is for documentation only.
            if (first == 0x20 && b[1].toInt() == 0x01 && (b[2].toInt() and 0xff) == 0x0d && (b[3].toInt() and 0xff) == 0xb8) return false
            return true
        }
    }
}

/** A URL's host, as [RemotePictures.hostKind] reads it. */
internal sealed interface HostKind {
    data object Name : HostKind
    data object Refused : HostKind
    data class Address(val address: InetAddress) : HostKind
}

/** The per-device setting Load pictures from the web (ED13): On, Wi-Fi only, or Off. */
enum class WebPictureSetting(val key: String, val label: String) {
    ON("on", "On"),
    WIFI_ONLY("wifi", "Wi-Fi only"),
    OFF("off", "Off"),
    ;

    /** How pictures show in a note opened now: on mobile data with Wi-Fi only, they wait for a tap. */
    fun mode(metered: Boolean): WebPictureMode = when (this) {
        ON -> WebPictureMode.ON
        WIFI_ONLY -> if (metered) WebPictureMode.WAIT else WebPictureMode.ON
        OFF -> WebPictureMode.OFF
    }

    /** Whether a picture may be fetched now: [tapped] is a Tap to load. */
    fun allows(metered: Boolean, tapped: Boolean): Boolean = when (mode(metered)) {
        WebPictureMode.ON -> true
        WebPictureMode.WAIT -> tapped
        WebPictureMode.OFF -> false
    }

    companion object {
        fun of(key: String?): WebPictureSetting = entries.firstOrNull { it.key == key } ?: ON
    }
}

/** Where [WebPictureSetting] is kept: this phone's own preferences (not synced, as the web's is per browser). */
class WebPictureSettings(private val prefs: SharedPreferences) {
    private val _setting = MutableStateFlow(WebPictureSetting.of(prefs.getString(KEY, null)))
    val setting: StateFlow<WebPictureSetting> = _setting.asStateFlow()

    fun set(value: WebPictureSetting) {
        prefs.edit().putString(KEY, value.key).apply()
        _setting.value = value
    }

    companion object {
        const val PREFS = "penmoss.webPictures"
        private const val KEY = "load"
    }
}

/**
 * Pictures from web addresses for the editor (ED13): the setting, the network, and the fetches.
 * The page is told the mode before each open; each request is checked again here, so a picture
 * held for a tap is never fetched without one, whatever the page asks.
 */
class WebPictures(
    val settings: WebPictureSettings,
    val pictures: RemotePictures,
    /** Whether the network is metered now (mobile data); true when unknown. */
    private val metered: () -> Boolean,
) {
    /** How web pictures show in a note opened now. */
    fun mode(): WebPictureMode = settings.setting.value.mode(metered())

    /** The WebView's answer for one picture, or null (404): refused by the setting, or not to be had. */
    fun respond(request: EditorWebView.RemoteRequest): android.webkit.WebResourceResponse? {
        if (!settings.setting.value.allows(metered(), request.tapped)) return null
        val (file, ext) = pictures.fileFor(request.address) ?: return null
        return EditorWebView.remoteResponse(file, ext)
    }
}
