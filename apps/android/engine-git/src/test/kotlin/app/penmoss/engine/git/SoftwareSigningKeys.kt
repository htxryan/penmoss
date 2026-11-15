package app.penmoss.engine.git

import java.io.File
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.TimeUnit

/** A software P-256 key standing in for the Keystore's (#172, A921). */
class SoftwareKey(val pair: KeyPair = generate()) : CommitSigningKey {
    override val publicKey: ECPublicKey get() = pair.public as ECPublicKey

    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(pair.private)
        update(data)
        sign()
    }

    companion object {
        fun generate(): KeyPair = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
    }
}

/** A software Ed25519 key standing in for the Keystore's, where KeyMint has Ed25519 (#174 review). */
class SoftwareEd25519Key(val pair: KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()) : CommitSigningKey {
    override val publicKey: PublicKey get() = pair.public

    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("Ed25519").run {
        initSign(pair.private)
        update(data)
        sign()
    }
}

/** The Keystore as the app keeps it, in memory: [lose] is the Keystore losing the key. */
class SoftwareKeyStore : CommitKeyStore {
    var current: CommitSigningKey? = null

    override fun key(): CommitSigningKey? = current

    override fun create(type: CommitKeyType): CommitSigningKey =
        (if (type == CommitKeyType.ED25519) SoftwareEd25519Key() else SoftwareKey()).also { current = it }

    fun lose() {
        current = null
    }
}

/** System git and OpenSSH, as GitHub's check stands in here (#172). */
object SignatureChecks {
    fun run(dir: File, vararg command: String, input: String? = null): Pair<Int, String> {
        val process = ProcessBuilder(*command).directory(dir).redirectErrorStream(true).apply {
            environment()["GIT_CONFIG_GLOBAL"] = "/dev/null"
            environment()["GIT_CONFIG_NOSYSTEM"] = "1"
        }.start()
        if (input != null) process.outputStream.use { it.write(input.toByteArray()) } else process.outputStream.close()
        val out = process.inputStream.bufferedReader().readText()
        check(process.waitFor(60, TimeUnit.SECONDS)) { "${command.toList()} timed out" }
        return process.exitValue() to out
    }

    /** `git verify-commit` of [sha] in [repo] against an allowed-signers file naming [email]'s [keyLine]. */
    fun verifyCommit(repo: File, sha: String, email: String, keyLine: String, scratch: File): Pair<Int, String> {
        val allowed = File.createTempFile("allowed", "", scratch).apply { writeText("$email ${keyLine.split(' ').take(2).joinToString(" ")}\n") }
        return run(
            repo, "git", "-c", "gpg.format=ssh", "-c", "gpg.ssh.allowedSignersFile=${allowed.absolutePath}",
            "verify-commit", "--raw", sha,
        )
    }
}
