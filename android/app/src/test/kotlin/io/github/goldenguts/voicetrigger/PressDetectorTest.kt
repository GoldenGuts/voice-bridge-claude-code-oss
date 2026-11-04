package io.github.goldenguts.voicetrigger

import org.junit.Assert.assertEquals
import org.junit.Test

class PressDetectorTest {
    private class Clock {
        var now = 0L
        private val timers = mutableListOf<Pair<Long, () -> Unit>?>()

        fun schedule(ms: Long, run: () -> Unit): PressDetector.Cancel {
            val i = timers.size
            timers += (now + ms) to run
            return PressDetector.Cancel { timers[i] = null }
        }

        fun advance(ms: Long) {
            now += ms
            for (i in timers.indices) {
                val t = timers[i] ?: continue
                if (t.first <= now) {
                    timers[i] = null
                    t.second()
                }
            }
        }
    }

    private val next = 87
    private val clock = Clock()
    private val got = mutableListOf<Gesture>()

    private fun detector(vararg kinds: Kind) = PressDetector({ if (it == next) kinds.toSet() else emptySet() }, clock::schedule, got::add)

    private fun PressDetector.tap(key: Int = next) {
        down(key)
        clock.advance(50)
        up(key)
    }

    @Test
    fun aKeyNobodyWatchesReactsAtOnce() {
        detector().tap(99)
        assertEquals(listOf(Gesture(99, Kind.ONE)), got)
    }

    @Test
    fun aWatchedSinglePressDoesNotWait() {
        detector(Kind.ONE).tap()
        assertEquals(listOf(Gesture(next, Kind.ONE)), got)
    }

    @Test
    fun twoQuickPressesAreOneGesture() {
        val d = detector(Kind.TWO)
        d.tap()
        clock.advance(100)
        d.tap()
        assertEquals(listOf(Gesture(next, Kind.TWO)), got)
    }

    @Test
    fun oneSlowPressStillArrivesWhenTwoIsWatched() {
        detector(Kind.TWO).tap()
        assertEquals(emptyList<Gesture>(), got)
        clock.advance(PressDetector.TAP_MS)
        assertEquals(listOf(Gesture(next, Kind.ONE)), got)
    }

    @Test
    fun holdFiresOnceAndItsReleaseIsSilent() {
        val d = detector(Kind.HOLD)
        d.down(next)
        clock.advance(PressDetector.HOLD_MS)
        d.up(next)
        clock.advance(PressDetector.TAP_MS)
        assertEquals(listOf(Gesture(next, Kind.HOLD)), got)
    }

    @Test
    fun aShortPressIsNotAHold() {
        val d = detector(Kind.HOLD)
        d.tap()
        clock.advance(PressDetector.HOLD_MS)
        assertEquals(listOf(Gesture(next, Kind.ONE)), got)
    }

    @Test
    fun anotherKeyEndsTheWait() {
        val d = detector(Kind.TWO)
        d.tap()
        d.tap(99)
        assertEquals(listOf(Gesture(next, Kind.ONE), Gesture(99, Kind.ONE)), got)
    }
}
