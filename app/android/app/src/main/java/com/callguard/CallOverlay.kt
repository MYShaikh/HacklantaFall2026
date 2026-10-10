package com.callguard

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.telecom.TelecomManager
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * What the user sees while a call comes in. Needs the "Display over other apps" permission (see canShow).
 *
 *  - Normal call: a card across the top with the number, its report count, and Block / Open / Dismiss.
 *  - Spam call (the phone labelled it, or at least SPAM_THRESHOLD users reported it): a card in the exact
 *    centre of the screen with one giant button that blocks the number and ends the call.
 *
 * The call-screening service can run while the React app is closed, so this talks to the Django server
 * itself, using the server address and login token the JS app saved in the default preferences.
 */
object CallOverlay {
  private const val AUTO_HIDE_MS = 30_000L
  private const val SPAM_THRESHOLD = 2 // keep in sync with the backend
  private const val RED = "#c81e1e"
  private const val PAUSE_MS = 10 * 60_000L // how long Pause keeps the ringer silent

  private val main = Handler(Looper.getMainLooper())
  private var card: View? = null
  private var windowManager: WindowManager? = null

  // The "Checking reports…" line of the normal card, updated when the server replies.
  private var cardInfo: TextView? = null

  fun canShow(context: Context) = Settings.canDrawOverlays(context)

  /**
   * @param scamLabel the label the phone/carrier attached to the call (e.g. "Scam Likely"), if any.
   * @param knownSpam the number is on the known-spam list saved by the app.
   */
  fun show(context: Context, number: String, scamLabel: String? = null, knownSpam: Boolean = false) {
    val app = context.applicationContext
    main.post {
      val detail = when {
        number.isEmpty() -> null
        scamLabel != null -> "Your phone flagged this call: $scamLabel"
        knownSpam -> "Known spam number — reported before"
        else -> null
      }
      present(app, number, spamDetail = detail)
      if (number.isNotEmpty()) lookup(app, number)
    }
  }

  fun hide() {
    card?.let { runCatching { windowManager?.removeView(it) } }
    card = null
    cardInfo = null
  }

  /** Replaces whatever card is showing. [spamDetail] non-null means the centred spam layout. */
  private fun present(app: Context, number: String, spamDetail: String?) {
    hide()
    val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val info = text(app, if (number.isEmpty()) "Caller ID is hidden" else "Checking reports…", 14f, Color.DKGRAY)
    val view = if (spamDetail != null) buildSpam(app, number, spamDetail) else buildNormal(app, number, info)
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      // Not focusable, so the phone's own call screen keeps working underneath.
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.CENTER
    }
    try {
      wm.addView(view, params)
      card = view
      windowManager = wm
      cardInfo = info
      app.getSharedPreferences("${app.packageName}_preferences", Context.MODE_PRIVATE)
        .edit().remove("last_overlay_error").apply()
      main.postDelayed({ if (card === view) hide() }, AUTO_HIDE_MS)
    } catch (e: Exception) {
      // Permission revoked or window refused. Recorded for the app's status line.
      app.getSharedPreferences("${app.packageName}_preferences", Context.MODE_PRIVATE)
        .edit().putString("last_overlay_error", "${e.javaClass.simpleName}: ${e.message}").apply()
    }
  }

  private fun buildNormal(app: Context, number: String, info: TextView): View {
    val box = box(app, "normal", Color.parseColor("#1a56db"), 18)
    box.addView(text(app, "CallGuard · Incoming call", 12f, Color.GRAY))
    box.addView(text(app, number.ifEmpty { "Hidden number" }, 26f, Color.BLACK, bold = true))
    box.addView(info)

    val block = Button(app).apply { text = "Block"; isEnabled = number.isNotEmpty() }
    block.setOnClickListener {
      block.isEnabled = false
      info.text = "Blocking…"
      addLocalBlock(app, number)
      blockOnServer(app, number) { ok ->
        main.post { info.text = if (ok) "Blocked" else "Blocked on this phone (server not reached)" }
      }
    }
    val report = Button(app).apply { text = "Report spam"; isEnabled = number.isNotEmpty() }
    report.setOnClickListener {
      report.isEnabled = false
      info.text = "Reporting…"
      reportOnServer(app, number) { ok ->
        main.post { info.text = if (ok) "Reported as spam" else "Couldn't report (already reported, or server not reached)" }
      }
    }
    val open = Button(app).apply { text = "Open CallGuard" }
    open.setOnClickListener {
      hide()
      app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
    val dismiss = Button(app).apply { text = "Dismiss" }
    dismiss.setOnClickListener { hide() }

    box.addView(buttonRow(app, block, report))
    box.addView(pauseButton(app))
    box.addView(buttonRow(app, open, dismiss))
    return margin(app, box)
  }

  private fun buttonRow(app: Context, vararg buttons: Button) = LinearLayout(app).apply {
    orientation = LinearLayout.HORIZONTAL
    buttons.forEach { addView(it, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)) }
  }

  private fun buildSpam(app: Context, number: String, detail: String): View {
    val box = box(app, "spam", Color.parseColor(RED), 20).apply { gravity = Gravity.CENTER_HORIZONTAL }
    box.addView(text(app, "⚠ SPAM CALL", 16f, Color.parseColor(RED), bold = true).apply { gravity = Gravity.CENTER })
    box.addView(text(app, number, 28f, Color.BLACK, bold = true).apply { gravity = Gravity.CENTER })
    box.addView(text(app, detail, 14f, Color.DKGRAY).apply { gravity = Gravity.CENTER })

    val big = Button(app).apply {
      text = "THIS NUMBER IS A SPAM CALL\n$number\nBLOCK IT & END THE CALL"
      textSize = 20f
      setTextColor(Color.WHITE)
      setTypeface(typeface, Typeface.BOLD)
      background = GradientDrawable().apply {
        setColor(Color.parseColor(RED))
        cornerRadius = dp(app, 16).toFloat()
      }
    }
    big.setOnClickListener {
      big.isEnabled = false
      big.text = "Blocking…"
      addLocalBlock(app, number)
      blockOnServer(app, number) { }
      val ended = endCall(app)
      big.text = if (ended) "BLOCKED\nCall ended" else "BLOCKED\nCould not end the call — decline it yourself"
      main.postDelayed({ hide() }, 2500)
    }
    box.addView(big, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(app, 150)).apply {
      topMargin = dp(app, 14)
    })

    box.addView(pauseButton(app))
    val notSpam = Button(app).apply { text = "Not spam — dismiss" }
    notSpam.setOnClickListener { hide() }
    box.addView(notSpam)
    return margin(app, box)
  }

  private fun lookup(app: Context, number: String) {
    Thread {
      val reply = request(app, "/lookup/?number=${Uri.encode(number)}", "GET", null)
      val count = reply?.optInt("report_count") ?: 0
      val category = reply?.optString("top_category")?.takeIf { it.isNotBlank() && it != "null" }
      main.post {
        val showing = card ?: return@post
        when {
          reply == null -> setInfo("Could not check reports (is the server reachable?)")
          count >= SPAM_THRESHOLD && showing.tag != "spam" ->
            present(app, number, spamDetail = "$count users reported this number${category?.let { " ($it)" } ?: ""}")
          count >= SPAM_THRESHOLD -> Unit
          count == 1 -> setInfo("1 report so far")
          else -> setInfo("No reports for this number")
        }
      }
    }.start()
  }

  private fun setInfo(message: String) {
    cardInfo?.text = message
  }

  /**
   * "Pause": silences the ringer and vibration so the user can carry on with what they were doing. The caller is
   * NOT hung up; their call keeps ringing on their side. Needs "Do Not Disturb access" (see silence).
   */
  private fun pauseButton(app: Context): Button {
    val pause = Button(app).apply { text = "Pause — silence ringing" }
    pause.setOnClickListener {
      if (silence(app)) {
        pause.text = "Silenced for ${PAUSE_MS / 60_000} min · caller not hung up"
        pause.isEnabled = false
      } else {
        pause.text = "Allow Do Not Disturb access, then tap Pause again"
        runCatching {
          app.startActivity(
            Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        }
      }
    }
    return pause
  }

  /** Sets the ringer to silent (no ring, no vibration) and schedules putting it back. False without DND access. */
  private fun silence(app: Context): Boolean {
    val notifications = app.getSystemService(NotificationManager::class.java)
    if (!notifications.isNotificationPolicyAccessGranted) return false
    val audio = app.getSystemService(AudioManager::class.java)
    val prefs = app.getSharedPreferences("${app.packageName}_preferences", Context.MODE_PRIVATE)
    // Remember the mode to go back to, unless a pause is already holding it.
    if (audio.ringerMode != AudioManager.RINGER_MODE_SILENT) {
      prefs.edit().putInt("restore_ringer_mode", audio.ringerMode).apply()
    }
    audio.ringerMode = AudioManager.RINGER_MODE_SILENT

    // An alarm, not a Handler, so the ringer comes back even if Android kills this process meanwhile.
    val restore = PendingIntent.getBroadcast(
      app, 77, Intent(app, RestoreRingerReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    app.getSystemService(AlarmManager::class.java)
      .setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + PAUSE_MS, restore)
    return true
  }

  /** Puts the ringer back to what it was before Pause. Safe to call at any time. */
  fun restoreRinger(context: Context) {
    val app = context.applicationContext
    val prefs = app.getSharedPreferences("${app.packageName}_preferences", Context.MODE_PRIVATE)
    val mode = prefs.getInt("restore_ringer_mode", -1)
    if (mode < 0) return
    runCatching {
      if (app.getSystemService(NotificationManager::class.java).isNotificationPolicyAccessGranted) {
        app.getSystemService(AudioManager::class.java).ringerMode = mode
      }
    }
    prefs.edit().remove("restore_ringer_mode").apply()
  }

  /** Applies the block on this phone straight away, so the next call is rejected even if the server is down. */
  private fun addLocalBlock(app: Context, number: String) {
    if (number.isEmpty()) return
    val prefs = app.getSharedPreferences("${app.packageName}_preferences", Context.MODE_PRIVATE)
    val existing = prefs.getString("blocked_numbers", "").orEmpty().split(",").filter { it.isNotBlank() }
    if (number !in existing) prefs.edit().putString("blocked_numbers", (existing + number).joinToString(",")).apply()
  }

  private fun reportOnServer(app: Context, number: String, done: (Boolean) -> Unit) {
    if (number.isEmpty()) return done(false)
    Thread {
      val body = JSONObject().put("number", number).put("category", "spam").toString()
      done(request(app, "/reports/", "POST", body) != null)
    }.start()
  }

  private fun blockOnServer(app: Context, number: String, done: (Boolean) -> Unit) {
    if (number.isEmpty()) return done(false)
    Thread {
      done(request(app, "/blocklist/", "POST", JSONObject().put("number", number).toString()) != null)
    }.start()
  }

  /**
   * Rejects the ringing call. Needs the runtime "Answer phone calls" permission (the JS app asks for it);
   * returns false if that was refused or Android won't end this call.
   */
  @SuppressLint("MissingPermission")
  private fun endCall(app: Context): Boolean = try {
    app.getSystemService(TelecomManager::class.java).endCall()
  } catch (_: Exception) {
    false
  }

  /** Minimal authenticated call to the Django API. Returns the JSON body, or null on any failure. */
  private fun request(app: Context, path: String, method: String, body: String?): JSONObject? {
    val prefs = app.getSharedPreferences("${app.packageName}_preferences", Context.MODE_PRIVATE)
    val server = prefs.getString("server_url", null) ?: return null
    val token = prefs.getString("auth_token", null) ?: return null
    return try {
      val conn = URL("$server/api$path").openConnection() as HttpURLConnection
      conn.requestMethod = method
      conn.connectTimeout = 4000
      conn.readTimeout = 4000
      conn.setRequestProperty("Authorization", "Token $token")
      conn.setRequestProperty("Content-Type", "application/json")
      if (body != null) {
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toByteArray()) }
      }
      if (conn.responseCode in 200..299) JSONObject(conn.inputStream.bufferedReader().readText()) else null
    } catch (_: Exception) {
      null
    }
  }

  private fun box(app: Context, kind: String, stroke: Int, padding: Int) = LinearLayout(app).apply {
    orientation = LinearLayout.VERTICAL
    tag = kind
    setPadding(dp(app, padding), dp(app, padding - 2), dp(app, padding), dp(app, padding - 4))
    background = GradientDrawable().apply {
      setColor(Color.WHITE)
      cornerRadius = dp(app, 16).toFloat()
      setStroke(dp(app, 3), stroke)
    }
    elevation = dp(app, 8).toFloat()
  }

  /** Side margins around the card, so it doesn't touch the screen edges. The wrapper carries the card's tag. */
  private fun margin(app: Context, box: LinearLayout): View = LinearLayout(app).apply {
    setPadding(dp(app, 12), 0, dp(app, 12), 0)
    tag = box.tag
    addView(box, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
  }

  private fun text(app: Context, value: String, size: Float, color: Int, bold: Boolean = false) =
    TextView(app).apply {
      text = value
      textSize = size
      setTextColor(color)
      if (bold) setTypeface(typeface, Typeface.BOLD)
    }

  private fun dp(app: Context, value: Int) = (value * app.resources.displayMetrics.density).toInt()
}
