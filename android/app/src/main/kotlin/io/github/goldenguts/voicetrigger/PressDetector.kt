package io.github.goldenguts.voicetrigger

enum class Kind { ONE, TWO, HOLD }

data class Gesture(val key: Int, val kind: Kind)

/**
 * Turns key down/up events into gestures. A key waits only for the gestures watched on it, so a key
 * nobody mapped reacts at once, and music control keeps its normal speed.
 */
class PressDetector(
    private val watched: (key: Int) -> Set<Kind>,
    private val schedule: (delayMs: Long, run: () -> Unit) -> Cancel,
    private val onGesture: (Gesture) -> Unit,
) {
    fun interface Cancel { fun cancel() }

    private var key = NONE
    private var count = 0
    private var isDown = false
    private var held = false
    private var holdTimer: Cancel? = null
    private var tapTimer: Cancel? = null

    fun down(k: Int) {
        if (k != key) flush()
        tapTimer?.cancel()
        key = k
        isDown = true
        held = false
        if (Kind.HOLD in watched(k)) {
            holdTimer = schedule(HOLD_MS) {
                held = true
                count = 0
                onGesture(Gesture(k, Kind.HOLD))
            }
        }
    }

    fun up(k: Int) {
        if (k != key || !isDown) down(k) // a press whose down we did not see
        holdTimer?.cancel()
        isDown = false
        if (held) return reset()
        count++
        val w = watched(k)
        when {
            Kind.TWO !in w -> flush()
            count >= 2 -> {
                onGesture(Gesture(k, Kind.TWO))
                reset()
            }
            else -> tapTimer = schedule(TAP_MS) { flush() }
        }
    }

    private fun flush() {
        val k = key
        val n = count
        tapTimer?.cancel()
        reset()
        repeat(n) { onGesture(Gesture(k, Kind.ONE)) }
    }

    private fun reset() {
        key = NONE
        count = 0
        isDown = false
        held = false
    }

    companion object {
        const val HOLD_MS = 600L
        const val TAP_MS = 400L
        private const val NONE = -1
    }
}
