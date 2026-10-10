package com.callguard

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.telecom.CallScreeningService

/**
 * Rejects incoming calls from numbers the user blocked (and known spam, if the user switched that on).
 * The JS app writes both lists (comma-separated, normalized like the backend) to the default preferences under
 * "blocked_numbers" and "spam_numbers" (known spam), and the switch under "auto_block_spam" ("1" = reject known
 * spam silently). This service only reads.
 *
 * Calls that are let through show a CallOverlay card (or a notification when overlays aren't allowed) so the
 * caller can be checked. Both open CallGuard via callguard://incoming?number=...
 */
class BlockingScreeningService : CallScreeningService() {
  override fun onScreenCall(callDetails: Call.Details) {
    val prefs = getSharedPreferences("${packageName}_preferences", Context.MODE_PRIVATE)
    val blocked = list(prefs.getString("blocked_numbers", ""))
    val knownSpam = list(prefs.getString("spam_numbers", ""))
    // Known spam is only rejected silently if the user switched that on; otherwise it rings and shows the spam card.
    val rejectSpam = prefs.getString("auto_block_spam", "0") == "1"
    val incoming = normalize(callDetails.handle?.schemeSpecificPart)
    val block = incoming.isNotEmpty() && (incoming in blocked || (rejectSpam && incoming in knownSpam))

    respondToCall(
      callDetails,
      CallResponse.Builder().setDisallowCall(block).setRejectCall(block).setSkipNotification(block).build(),
    )

    val overlayAllowed = CallOverlay.canShow(this)
    val decision = when {
      block -> "blocked"
      overlayAllowed && incoming.isEmpty() -> "hidden caller ID, card requested"
      incoming.isEmpty() -> "hidden caller ID, overlay permission missing, nothing shown"
      overlayAllowed -> "card requested"
      else -> "overlay permission missing, notification used instead"
    }
    // Written for the app's status line, so a missing pop-up can be diagnosed from the phone.
    prefs.edit().putString("last_screened", "${System.currentTimeMillis()}|$incoming|$decision").apply()

    if (block) return

    val locked = getSystemService(KeyguardManager::class.java).isKeyguardLocked
    val launch = prefs.getString("open_app_on_call", "1") != "0"
    if (overlayAllowed) {
      // A name like "Scam Likely" from the carrier/dialer makes this a spam call straight away.
      val label = callDetails.callerDisplayName?.takeIf { Regex("scam|spam|fraud", RegexOption.IGNORE_CASE).containsMatchIn(it) }
      CallOverlay.show(this, incoming, label, incoming.isNotEmpty() && incoming in knownSpam)
      // Android only lets a background app launch itself while it has a visible window, so wait for the card.
      // Launched plain (no number): the card is the one prompt, so the app must not show its own incoming-call box.
      if (launch) Handler(Looper.getMainLooper()).postDelayed({ runCatching { startActivity(openIntent("")) } }, 400)
    }
    // Overlays don't draw over the lock screen; a full-screen notification opens the app there instead.
    if ((locked || !overlayAllowed) && incoming.isNotEmpty()) notifyIncoming(incoming)
  }

  /** Opens CallGuard's incoming-call screen, or just the app when the caller's number is hidden. */
  private fun openIntent(number: String): Intent {
    val intent = if (number.isEmpty()) Intent(this, MainActivity::class.java)
    else Intent(Intent.ACTION_VIEW, Uri.parse("callguard://incoming?number=${Uri.encode(number)}")).setClass(this, MainActivity::class.java)
    return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  }

  /**
   * Fallback when "Display over other apps" isn't granted: a heads-up notification with a full-screen intent
   * (opens the app over a locked screen; a tappable banner while the phone is in use).
   */
  private fun notifyIncoming(number: String) {
    val open = openIntent(number)

    try {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH),
      )
      val pending = PendingIntent.getActivity(
        this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val notification = Notification.Builder(this, CHANNEL)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("Incoming call")
        .setContentText("$number — tap to check this caller")
        .setCategory(Notification.CATEGORY_CALL)
        .setContentIntent(pending)
        .setFullScreenIntent(pending, true)
        .setAutoCancel(true)
        .build()
      manager.notify(NOTIFICATION_ID, notification)
    } catch (_: Exception) {
      // Notifications are best effort; blocking must never fail because of them.
    }
  }

  private fun list(value: String?): Set<String> = value.orEmpty().split(",").filter { it.isNotBlank() }.toSet()

  // Same rules as the backend's normalize_number and the JS normalizeNumber.
  private fun normalize(raw: String?): String {
    val trimmed = raw?.trim().orEmpty()
    val digits = trimmed.filter { it.isDigit() }
    return when {
      digits.isEmpty() -> ""
      trimmed.startsWith("+") -> "+$digits"
      digits.length == 10 -> "+1$digits"
      digits.length == 11 && digits.startsWith("1") -> "+$digits"
      else -> digits
    }
  }

  companion object {
    private const val CHANNEL = "incoming_calls"
    private const val NOTIFICATION_ID = 1001
  }
}
