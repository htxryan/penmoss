# JGit on Android (T50 G0). Each rule says why.
# JGit loads its message bundles by reflection over public String fields (TranslationBundle).
# Each bundle's class name names its .properties resource, so the names stay too; AGP 9's
# strict full mode keeps no constructor unless asked.
-keep class org.eclipse.jgit.internal.JGitText { public *; }
-keepnames class * extends org.eclipse.jgit.nls.TranslationBundle
-keepclassmembers class * extends org.eclipse.jgit.nls.TranslationBundle { public <fields>; public <init>(); }
-keepclassmembers enum org.eclipse.jgit.** { public static **[] values(); public static ** valueOf(java.lang.String); }
# Transports register themselves by name; the smart HTTP one is what the probe uses.
-keep class org.eclipse.jgit.transport.TransportHttp { *; }
-keep class org.eclipse.jgit.transport.Transport { *; }
-keep class org.eclipse.jgit.transport.http.JDKHttpConnectionFactory { *; }
# What R8 reports missing against android.jar (minSdk 30), and why each is safe to leave out:
# - java.lang.management / javax.management: JMX statistics for WindowCache. Off with
#   WindowCacheConfig.setExposeStatsViaJmx(false) (GitProbe.lowMemoryConfig), and Monitoring
#   returns before touching them unless a `jmx.*` git config key asks.
-dontwarn java.lang.management.**
-dontwarn javax.management.**
# - org.ietf.jgss: HTTP "Negotiate" (Kerberos) auth. Reached only if a server answers 401 with
#   WWW-Authenticate: Negotiate; github.com never does. A corporate host might: G7 must catch
#   Throwable around transport calls and show "can't authenticate".
-dontwarn org.ietf.jgss.**
# - java.lang.ProcessHandle: GC's pid lock. Never run JGit's gc on Android: the clone is
#   disposable, so G7 re-clones (shallow) when the object store grows.
-dontwarn java.lang.ProcessHandle
# - org.slf4j.impl: slf4j 1.7's binder lookup (JGit 6.6 depends on slf4j 1.7); no binder is
#   bundled, so slf4j logs nowhere.
-dontwarn org.slf4j.impl.StaticLoggerBinder
