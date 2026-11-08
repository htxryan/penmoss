package app.penmoss.editor

import org.junit.Assert.assertEquals
import org.junit.Test

/** Picked pictures are decoded no larger than notes show them (A314). */
class PickedPicturesTest {
    @Test
    fun aLargePhotoIsDecodedScaledDownToTheLongestEdge() {
        // A 50 MP Pixel photo: 8160 × 6120 would be a 200 MB bitmap.
        assertEquals(4096 to 3072, PickedPictures.targetSize(8160, 6120))
        assertEquals(3072 to 4096, PickedPictures.targetSize(6120, 8160))
    }

    @Test
    fun aPictureThatFitsKeepsItsSize() {
        assertEquals(4000 to 3000, PickedPictures.targetSize(4000, 3000))
        assertEquals(4096 to 10, PickedPictures.targetSize(4096, 10))
    }

    @Test
    fun aVeryThinPictureNeverGoesToNothing() {
        assertEquals(4096 to 1, PickedPictures.targetSize(100_000, 2))
    }
}
