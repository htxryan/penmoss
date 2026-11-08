package app.penmoss.git

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.penmoss.engine.git.CommitKeyStore
import app.penmoss.engine.git.CommitKeyType
import app.penmoss.engine.git.CommitSigningKey
import app.penmoss.engine.git.GitRefusal
import app.penmoss.engine.git.SshCommitSigner
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * This phone's commit-signing key (#172, A921): an ECDSA P-256 key (`ecdsa-sha2-nistp256`) or,
 * where the device's KeyMint has it, an Ed25519 key (`ssh-ed25519`), made in the Android
 * Keystore. Its private half never leaves the Keystore and is never imported: the app asks it to
 * sign, and shows only the public half. No user authentication, since background syncs sign too
 * (WorkManager, A881).
 *
 * A new key is made under a new alias and must sign and verify before it replaces the one before
 * it, so a kind the Keystore cannot make leaves the old key in place. The newest alias is the key.
 */
class KeystoreCommitKeys(private val alias: String = ALIAS) : CommitKeyStore {
    private fun keystore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    /** This store's aliases, newest first: the first one is the key, the rest are left over. */
    private fun aliases(store: KeyStore): List<String> =
        store.aliases().toList().filter { it == alias || it.startsWith("$alias.") }
            .sortedWith(compareByDescending<String> { store.getCreationDate(it)?.time ?: 0L }.thenByDescending { it })

    private fun keyAt(store: KeyStore, at: String): CommitSigningKey? {
        val entry = runCatching { store.getEntry(at, null) as? KeyStore.PrivateKeyEntry }.getOrNull() ?: return null
        val public: PublicKey = entry.certificate.publicKey
        val type = runCatching { CommitKeyType.of(public) }.getOrNull() ?: return null
        return object : CommitSigningKey {
            override val publicKey: PublicKey = public

            override fun sign(data: ByteArray): ByteArray = Signature.getInstance(SshCommitSigner.algorithm(type)).run {
                initSign(entry.privateKey)
                update(data)
                sign()
            }
        }
    }

    override fun key(): CommitSigningKey? {
        val store = keystore()
        return aliases(store).firstOrNull()?.let { keyAt(store, it) }
    }

    override fun create(type: CommitKeyType): CommitSigningKey {
        val store = keystore()
        val before = aliases(store)
        val next = "$alias.${System.currentTimeMillis()}"
        val made = runCatching {
            val spec = KeyGenParameterSpec.Builder(next, KeyProperties.PURPOSE_SIGN).apply {
                when (type) {
                    CommitKeyType.P256 -> setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256)
                    CommitKeyType.ED25519 -> setAlgorithmParameterSpec(ECGenParameterSpec("ed25519")).setDigests(KeyProperties.DIGEST_NONE)
                }
            }.build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
            val key = keyAt(store, next) ?: error("the Keystore did not keep the new key")
            check(CommitKeyType.of(key.publicKey) == type) { "the Keystore made another kind of key" }
            val signer = SshCommitSigner(key)
            check(signer.verifies(PROBE, signer.sign(PROBE))) { "the new key does not sign" }
            key
        }
        val key = made.getOrElse { error ->
            runCatching { store.deleteEntry(next) }
            throw GitRefusal(
                "signing",
                when (type) {
                    CommitKeyType.ED25519 -> "This phone's Keystore cannot make an Ed25519 key, so your signing key is unchanged. Make a P-256 key instead."
                    CommitKeyType.P256 -> "This phone's Keystore could not make a signing key (${error.message}), so your signing key is unchanged."
                },
            )
        }
        for (old in before) runCatching { store.deleteEntry(old) }
        return key
    }

    companion object {
        private const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = "penmoss.git-signing"

        /** What a new key signs once, to show it can, before it replaces the one before it. */
        private val PROBE = "penmoss signing check\n".toByteArray()
    }
}
