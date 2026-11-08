package app.penmoss.gitprobe.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import app.penmoss.gitprobe.GitProbe;
import java.util.Locale;

/**
 * T50 G0's throwaway activity: runs GitProbe (shallow clone, fetch, commit on head, push, a
 * rejected stale push, rebuild and push) against a private github.com repo with a fine-grained
 * PAT, and shows the timings and memory. The PAT stays in memory only. "Copy results" puts the
 * whole log on the clipboard for the evidence doc.
 */
public final class ProbeActivity extends Activity {
  private final Handler main = new Handler(Looper.getMainLooper());
  private TextView out;
  private final StringBuilder log = new StringBuilder();

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout column = new LinearLayout(this);
    column.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (16 * getResources().getDisplayMetrics().density);
    column.setPadding(pad, pad * 3, pad, pad);

    EditText url = field("https://github.com/htxryan/penmoss-git-notebook-scratch.git", InputType.TYPE_TEXT_VARIATION_URI);
    EditText branch = field("pixel-1000", InputType.TYPE_CLASS_TEXT);
    EditText token = field("", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    token.setHint("Fine-grained PAT (Contents: read and write, this repo only)");
    Button run = new Button(this);
    run.setText("Run probe");
    Button copy = new Button(this);
    copy.setText("Copy results");
    out = new TextView(this);
    out.setTextIsSelectable(true);
    out.setTypeface(android.graphics.Typeface.MONOSPACE);
    out.setTextSize(11);

    column.addView(label("Repository (HTTPS)"));
    column.addView(url);
    column.addView(label("Branch"));
    column.addView(branch);
    column.addView(label("Token"));
    column.addView(token);
    column.addView(run);
    column.addView(copy);
    column.addView(out);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(column);
    setContentView(scroll);

    run.setOnClickListener(v -> {
      run.setEnabled(false);
      log.setLength(0);
      String u = url.getText().toString().trim();
      String b = branch.getText().toString().trim();
      String t = token.getText().toString().trim();
      append(String.format(Locale.ROOT, "%s %s, Android %s (SDK %d), %s", Build.MANUFACTURER, Build.MODEL, Build.VERSION.RELEASE, Build.VERSION.SDK_INT, Build.SUPPORTED_ABIS[0]));
      append(String.format(Locale.ROOT, "heap limit %d MB (large %d MB)", Runtime.getRuntime().maxMemory() / 1048576, ((android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE)).getLargeMemoryClass()));
      new Thread(() -> {
        long start = SystemClock.elapsedRealtime();
        GitProbe.isolateConfig(getCacheDir());
        GitProbe.lowMemoryConfig();
        GitProbe.Result r = GitProbe.run(getCacheDir(), u, b, t, this::append);
        Debug.MemoryInfo mem = new Debug.MemoryInfo();
        Debug.getMemoryInfo(mem);
        append(String.format(Locale.ROOT, "total %d ms; process PSS %d MB, Java heap %d MB, native heap %d MB",
            SystemClock.elapsedRealtime() - start, mem.getTotalPss() / 1024, mem.dalvikPss / 1024, mem.nativePss / 1024));
        append(r.ok ? "RESULT: OK" : "RESULT: FAILED " + r.error);
        main.post(() -> run.setEnabled(true));
      }, "probe").start();
    });
    copy.setOnClickListener(v -> {
      ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
      clipboard.setPrimaryClip(ClipData.newPlainText("JGit probe", log.toString()));
    });
  }

  private void append(String line) {
    synchronized (log) {
      log.append(line).append('\n');
    }
    main.post(() -> out.setText(log.toString()));
  }

  private EditText field(String value, int type) {
    EditText e = new EditText(this);
    e.setText(value);
    e.setInputType(type);
    e.setSingleLine(true);
    e.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    return e;
  }

  private TextView label(String text) {
    TextView t = new TextView(this);
    t.setText(text);
    return t;
  }
}
