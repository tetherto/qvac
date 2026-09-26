package io.tether.qvac.sdk.sample

import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

internal object QvacPalette {
    val Background = Color(0xFF0B1014)
    val Surface = Color(0xFF161E23)
    val SurfaceRaised = Color(0xFF1F2A30)
    val Accent = Color(0xFF48D6A4)
    val OnAccent = Color(0xFF07130F)
    val TextPrimary = Color(0xFFEFF7F4)
    val TextSecondary = Color(0xFFAABEB8)
    val Danger = Color(0xFFFF847C)
}

private val QvacColorScheme = darkColorScheme(
    primary = QvacPalette.Accent,
    onPrimary = QvacPalette.OnAccent,
    background = QvacPalette.Background,
    onBackground = QvacPalette.TextPrimary,
    surface = QvacPalette.Surface,
    onSurface = QvacPalette.TextPrimary,
    surfaceVariant = QvacPalette.SurfaceRaised,
    onSurfaceVariant = QvacPalette.TextSecondary,
    error = QvacPalette.Danger,
)

private val QvacShapes = Shapes(
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
)

@Composable
internal fun QvacSampleTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = QvacColorScheme,
        shapes = QvacShapes,
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = QvacPalette.Background,
            content = content,
        )
    }
}

internal fun ComponentActivity.enableQvacEdgeToEdge() {
    enableEdgeToEdge(
        statusBarStyle = SystemBarStyle.dark(AndroidColor.TRANSPARENT),
        navigationBarStyle = SystemBarStyle.dark(AndroidColor.TRANSPARENT),
    )
}
