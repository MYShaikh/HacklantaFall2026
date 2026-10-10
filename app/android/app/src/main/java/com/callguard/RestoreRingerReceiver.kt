package com.callguard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Fired by the alarm that CallOverlay sets when the user taps Pause: puts the ringer back as it was. */
class RestoreRingerReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    CallOverlay.restoreRinger(context)
  }
}
