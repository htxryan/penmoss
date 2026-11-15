package app.penmoss.engine.git

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.util.Base64

/** The kinds of signing key this phone makes (#172, A921; #174 review). */
enum class CommitKeyType(val ssh: String) {
    /** ECDSA P-256, which every Android Keystore has. */
    P256("ecdsa-sha2-nistp256"),

    /** Ed25519, which the Keystore has where the device's KeyMint does. */
    ED25519("ssh-ed25519"),
    ;

    companion object {
        /** The kind of [key]: a P-256 EC key, or an Ed25519 key (by its X.509 encoding). */
        fun of(key: PublicKey): CommitKeyType = when {
            key is ECPublicKey && key.params.curve.field.fieldSize == 256 -> P256
            ed25519Raw(key) != null -> ED25519
            else -> throw IllegalArgumentException("Only P-256 and Ed25519 keys sign commits")
        }

        /** `SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }`: the 12 bytes before the raw key. */
        private val ED25519_X509 = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

        /** The 32 raw bytes of an Ed25519 public key (RFC 8410), or null for any other key. */
        internal fun ed25519Raw(key: PublicKey): ByteArray? {
            val encoded = key.encoded ?: return null
            if (encoded.size != 44 || !encoded.copyOfRange(0, 12).contentEquals(ED25519_X509)) return null
            return encoded.copyOfRange(12, 44)
        }
    }
}

/**
 * A key that signs commits from this phone (#172, A921): a P-256 or Ed25519 key the app made in
 * the Android Keystore, which never leaves it. Kotlin sees its public half and asks it to sign;
 * tests on the JVM give a software key.
 */
interface CommitSigningKey {
    val publicKey: PublicKey

    /**
     * The signature of [data]: for P-256, `SHA256withECDSA`, the DER signature the Keystore
     * returns; for Ed25519, the 64-byte `Ed25519` signature (RFC 8032).
     */
    fun sign(data: ByteArray): ByteArray
}

/** Where this phone keeps its signing key (#172, A921): the Android Keystore in the app. */
interface CommitKeyStore {
    /** The key, or null when none was made (or the Keystore no longer has it). */
    fun key(): CommitSigningKey?

    /**
     * Makes a new key of [type], replacing any before it, and returns it. A kind the Keystore
     * cannot make throws, and the key before it stays.
     */
    fun create(type: CommitKeyType = CommitKeyType.P256): CommitSigningKey
}

/** Whether a notebook's commits are signed (#172, A921), read at each commit. */
sealed interface CommitSigning {
    /** Commits are made unsigned, as before. */
    data object Off : CommitSigning

    /** Every commit is signed with [signer]'s key; it throws when the key is gone or refuses. */
    class On(val signer: () -> SshCommitSigner) : CommitSigning
}

/**
 * Signs a commit as `git` does with `gpg.format=ssh` (#172, A921): an SSH signature
 * (OpenSSH's `PROTOCOL.sshsig`, namespace `git`, SHA-512 of the commit) that GitHub, `git
 * verify-commit` and `ssh-keygen -Y verify` check against the key's public half.
 */
class SshCommitSigner(private val key: CommitSigningKey) {
    private val type = CommitKeyType.of(key.publicKey)

    /** The public key as a `.pub` file and GitHub's "Add a signing key" take it. */
    fun publicKeyLine(comment: String): String =
        "${type.ssh} ${Base64.getEncoder().encodeToString(publicKeyBlob(key.publicKey))}" +
            comment.replace(Regex("\\s+"), " ").trim().let { if (it.isEmpty()) "" else " $it" }

    /** The armored signature for a commit's bytes (`CommitBuilder.build()`, before `gpgsig`). */
    fun sign(commit: ByteArray): String {
        val hash = MessageDigest.getInstance("SHA-512").digest(commit)
        val signed = bytes {
            write(MAGIC)
            string(NAMESPACE.toByteArray())
            string(ByteArray(0))
            string(HASH.toByteArray())
            string(hash)
        }
        val raw = key.sign(signed)
        val signature = bytes {
            string(type.ssh.toByteArray())
            when (type) {
                CommitKeyType.P256 -> {
                    val (r, s) = derToRs(raw)
                    string(bytes { mpint(r); mpint(s) })
                }
                CommitKeyType.ED25519 -> {
                    require(raw.size == 64) { "Not an Ed25519 signature" }
                    string(raw)
                }
            }
        }
        val blob = bytes {
            write(MAGIC)
            writeInt(1)
            string(publicKeyBlob(key.publicKey))
            string(NAMESPACE.toByteArray())
            string(ByteArray(0))
            string(HASH.toByteArray())
            string(signature)
        }
        val body = Base64.getEncoder().encodeToString(blob).chunked(70).joinToString("\n")
        return "-----BEGIN SSH SIGNATURE-----\n$body\n-----END SSH SIGNATURE-----\n"
    }

    /** Whether [armored] is a good signature of [commit] by this key (checked before use). */
    fun verifies(commit: ByteArray, armored: String): Boolean = runCatching {
        val blob = Base64.getMimeDecoder().decode(
            armored.lines().filter { it.isNotBlank() && !it.startsWith("-----") }.joinToString(""),
        )
        val input = java.io.DataInputStream(blob.inputStream())
        fun string(): ByteArray = ByteArray(input.readInt()).also { input.readFully(it) }
        val magic = ByteArray(6).also { input.readFully(it) }
        if (!magic.contentEquals(MAGIC) || input.readInt() != 1) return false
        if (!string().contentEquals(publicKeyBlob(key.publicKey))) return false
        if (String(string()) != NAMESPACE) return false
        string()
        if (String(string()) != HASH) return false
        val signature = java.io.DataInputStream(string().inputStream())
        fun part(): ByteArray = ByteArray(signature.readInt()).also { signature.readFully(it) }
        if (String(part()) != type.ssh) return false
        val proof = when (type) {
            CommitKeyType.P256 -> {
                val rs = java.io.DataInputStream(part().inputStream())
                fun mpint(): BigInteger = BigInteger(ByteArray(rs.readInt()).also { rs.readFully(it) })
                rsToDer(mpint(), mpint())
            }
            CommitKeyType.ED25519 -> part().also { if (it.size != 64) return false }
        }
        val signed = bytes {
            write(MAGIC)
            string(NAMESPACE.toByteArray())
            string(ByteArray(0))
            string(HASH.toByteArray())
            string(MessageDigest.getInstance("SHA-512").digest(commit))
        }
        java.security.Signature.getInstance(algorithm(type)).run {
            initVerify(key.publicKey)
            update(signed)
            verify(proof)
        }
    }.getOrDefault(false)

    companion object {
        private const val CURVE = "nistp256"
        private const val NAMESPACE = "git"
        private const val HASH = "sha512"
        private val MAGIC = "SSHSIG".toByteArray()

        /** The JCA signature algorithm a key of [type] signs with (what [CommitSigningKey.sign] uses). */
        fun algorithm(type: CommitKeyType): String = when (type) {
            CommitKeyType.P256 -> "SHA256withECDSA"
            CommitKeyType.ED25519 -> "Ed25519"
        }

        /**
         * The SSH public key blob: for P-256, `string key type, string curve, string Q` (RFC 5656
         * §3.1), Q uncompressed; for Ed25519, `string key type, string key` (RFC 8709 §4).
         */
        fun publicKeyBlob(key: PublicKey): ByteArray {
            if (CommitKeyType.of(key) == CommitKeyType.ED25519) {
                return bytes {
                    string(CommitKeyType.ED25519.ssh.toByteArray())
                    string(CommitKeyType.ed25519Raw(key)!!)
                }
            }
            key as ECPublicKey
            val q = ByteArray(65)
            q[0] = 4
            fixed(key.w.affineX).copyInto(q, 1)
            fixed(key.w.affineY).copyInto(q, 33)
            return bytes {
                string(CommitKeyType.P256.ssh.toByteArray())
                string(CURVE.toByteArray())
                string(q)
            }
        }

        /** A coordinate as 32 big-endian bytes. */
        private fun fixed(value: BigInteger): ByteArray {
            val raw = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
            require(raw.size <= 32) { "Coordinate too large" }
            return ByteArray(32 - raw.size) + raw
        }

        /** `SEQUENCE { INTEGER r, INTEGER s }` read back into r and s. */
        internal fun derToRs(der: ByteArray): Pair<BigInteger, BigInteger> {
            var at = 0
            fun next(): Int = der[at++].toInt() and 0xff
            fun length(): Int {
                val first = next()
                if (first < 0x80) return first
                var n = 0
                repeat(first and 0x7f) { n = (n shl 8) or next() }
                return n
            }
            fun integer(): BigInteger {
                require(next() == 0x02) { "Not a DER ECDSA signature" }
                val n = length()
                val value = BigInteger(der.copyOfRange(at, at + n))
                at += n
                return value
            }
            require(next() == 0x30) { "Not a DER ECDSA signature" }
            length()
            return integer() to integer()
        }

        private fun rsToDer(r: BigInteger, s: BigInteger): ByteArray {
            val parts = listOf(r, s).map { value ->
                val raw = value.toByteArray()
                byteArrayOf(0x02, raw.size.toByte()) + raw
            }
            val body = parts[0] + parts[1]
            return byteArrayOf(0x30, body.size.toByte()) + body
        }

        private fun bytes(write: DataOutputStream.() -> Unit): ByteArray {
            val out = ByteArrayOutputStream()
            DataOutputStream(out).use { it.write() }
            return out.toByteArray()
        }

        private fun DataOutputStream.string(value: ByteArray) {
            writeInt(value.size)
            write(value)
        }

        /** An SSH mpint: two's complement, big-endian, shortest form. */
        private fun DataOutputStream.mpint(value: BigInteger) {
            string(if (value.signum() == 0) ByteArray(0) else value.toByteArray())
        }
    }
}
