// Application compatibility repair for Expo Print 58.0.6. See README.md and EXPO_LICENSE.txt.
package expo.modules.print

import android.content.Context
import android.graphics.pdf.PdfRenderer
import android.os.Bundle
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentAdapterLayoutCallback
import android.print.PrintDocumentAdapterWriteCallback
import android.print.PrintDocumentInfo
import android.util.Base64
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/** A single retained PDF-to-file operation. All lifecycle transitions run on the main looper. */
internal class ReliablePdfRenderTask(
  private val context: Context,
  private val options: PrintOptions,
  private val outputFile: File,
  private val destination: ParcelFileDescriptor,
  private val onComplete: (ReliablePdfRenderTask, FilePrintResult?, CodedException?) -> Unit
) {
  private val main = Handler(Looper.getMainLooper())
  private val cancellation = CancellationSignal()
  private var webView: WebView? = null
  private var document: PrintDocumentAdapter? = null
  private var layoutStarted = false
  private var writeStarted = false
  private var inspectionStarted = false
  private var terminal = false
  private var destinationClosed = false
  private val timeout = Runnable {
    fail("PDF rendering timed out; native completion was not confirmed.")
  }

  fun start() = onMain {
    if (terminal) return@onMain
    main.postDelayed(timeout, 60_000L)
    try {
      val view = WebView(context)
      webView = view
      view.settings.defaultTextEncodingName = "UTF-8"
      view.settings.javaScriptEnabled = false
      view.settings.blockNetworkLoads = true
      view.settings.allowFileAccess = false
      view.settings.allowContentAccess = false
      options.textZoom?.let { view.settings.textZoom = it }
      view.webViewClient = if (Build.VERSION.SDK_INT >= 26) RendererAwareClient() else PdfClient()
      view.loadDataWithBaseURL(null, options.html ?: "", "text/html; charset=utf-8", "UTF-8", null)
    } catch (error: Exception) {
      fail("The PDF renderer could not start.", error)
    }
  }

  private open inner class PdfClient : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String?) = onMain {
          if (terminal || layoutStarted) return@onMain
          layoutStarted = true
          try {
            val adapter = view.createPrintDocumentAdapter("Document")
            document = adapter
            adapter.onStart()
            adapter.onLayout(null, attributes(), cancellation, object : PrintDocumentAdapterLayoutCallback() {
              override fun onLayoutFinished(info: PrintDocumentInfo?, changed: Boolean) = onMain {
                if (terminal || writeStarted) return@onMain
                if (cancellation.isCanceled) {
                  fail("PDF layout was cancelled; no completed export was confirmed.")
                  return@onMain
                }
                writeStarted = true
                try {
                  adapter.onWrite(arrayOf(PageRange.ALL_PAGES), destination, cancellation, writeCallback)
                } catch (error: Exception) {
                  fail("PDF writing could not start.", error)
                }
              }

              override fun onLayoutFailed(error: CharSequence?) {
                fail("PDF layout failed.")
              }

              override fun onLayoutCancelled() {
                fail("PDF layout was cancelled; no completed export was confirmed.")
              }
            }, Bundle())
          } catch (error: Exception) {
            fail("PDF layout could not start.", error)
          }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (request.isForMainFrame) fail("The PDF document could not be loaded.")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
          if (request.isForMainFrame) fail("The PDF document could not be loaded.")
        }

  }

  // Isolate API-26-only types from the client instantiated on supported Android 24/25.
  @RequiresApi(26)
  private inner class RendererAwareClient : PdfClient() {
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          fail("The PDF renderer stopped; native completion was not confirmed.")
          return true
        }
  }

  fun cancel() = onMain {
    fail("PDF rendering was cancelled; native completion was not confirmed.")
  }

  private val writeCallback = object : PrintDocumentAdapterWriteCallback() {
    override fun onWriteFinished(pages: Array<PageRange>) = onMain {
      if (terminal || inspectionStarted) return@onMain
      inspectionStarted = true
      try {
        closeDestination()
        val inspector = Executors.newSingleThreadExecutor { work ->
          Thread(work, "fyp-pdf-inspection").apply { isDaemon = true }
        }
        try {
          inspector.execute {
            var result: FilePrintResult? = null
            var failure: CodedException? = null
            try {
              val byteCount = outputFile.length()
              if (byteCount < 64L || byteCount > 25L * 1024L * 1024L) {
                throw UnexpectedPrintException("The completed PDF is empty or exceeds the supported 25 MiB limit.")
              }
              // PdfRenderer loading belongs on a worker; the main callback deadline stays responsive.
              val readDescriptor = ParcelFileDescriptor.open(outputFile, ParcelFileDescriptor.MODE_READ_ONLY)
              val renderer = try { PdfRenderer(readDescriptor) } catch (error: Exception) {
                readDescriptor.close()
                throw error
              }
              // PdfRenderer owns and closes this read descriptor after successful construction.
              val pageCount = renderer.use { it.pageCount }
              if (pageCount < 1 || pageCount > 500) {
                throw UnexpectedPrintException("The completed PDF does not contain a supported page count.")
              }
              val encoded = if (options.base64) Base64.encodeToString(outputFile.readBytes(), Base64.NO_WRAP) else null
              result = FilePrintResult(FileUtils.uriFromFile(outputFile).toString(), pageCount, encoded)
            } catch (error: Exception) {
              failure = UnexpectedPrintException("The completed PDF could not be verified.", error)
            } finally {
              inspector.shutdown()
              onMain {
                // A timeout/cancel may already have rejected. Late inspection never resumes again.
                if (!terminal) finish(result, failure ?: if (result == null) UnexpectedPrintException("PDF inspection did not return a verified result.") else null)
              }
            }
          }
        } catch (error: Exception) {
          inspector.shutdown()
          throw error
        }
      } catch (error: Exception) {
        fail("The completed PDF could not be verified.", error)
      }
    }

    override fun onWriteFailed(error: CharSequence?) {
      fail("PDF writing failed; no completed export was confirmed.")
    }

    override fun onWriteCancelled() {
      fail("PDF writing was cancelled; no completed export was confirmed.")
    }
  }

  private fun attributes(): PrintAttributes {
    var media = PrintAttributes.MediaSize(
      "id", "label",
      ((options.width ?: 612) / (72.0 / 1000.0)).roundToInt(),
      ((options.height ?: 792) / (72.0 / 1000.0)).roundToInt()
    )
    if (options.orientation == "landscape") media = media.asLandscape()
    return PrintAttributes.Builder()
      .setMediaSize(media)
      .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
      .setResolution(PrintAttributes.Resolution("id", "label", 72, 72))
      .build()
  }

  private fun closeDestination() {
    if (destinationClosed) return
    destinationClosed = true
    destination.close()
  }

  private fun fail(message: String, error: Throwable? = null) = onMain {
    finish(null, UnexpectedPrintException(message, error))
  }

  private fun finish(result: FilePrintResult?, error: CodedException?) {
    if (terminal) return
    terminal = true
    main.removeCallbacks(timeout)
    // Let a WebView/print callback unwind before destroying its native resources.
    main.post {
      var finalError = error
      fun cleanup(action: () -> Unit) {
        try { action() } catch (failure: Exception) {
          if (finalError == null) finalError = UnexpectedPrintException("PDF cleanup could not be confirmed.", failure)
        }
      }
      if (error != null) cleanup { cancellation.cancel() }
      val adapter = document
      document = null
      cleanup { adapter?.onFinish() }
      cleanup { closeDestination() }
      val view = webView
      webView = null
      cleanup { view?.stopLoading() }
      cleanup { view?.destroy() }
      // The module releases its strong task reference only after these cleanup attempts.
      onComplete(this, if (finalError == null) result else null, finalError)
    }
  }

  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post { action() }
  }
}
