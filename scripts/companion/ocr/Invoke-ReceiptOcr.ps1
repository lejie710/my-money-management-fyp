param([Parameter(Mandatory=$true)][string]$JobDirectory)
# Reviewed local Windows PowerShell 5.1 worker. No network, desktop or camera access.
$ErrorActionPreference = 'Stop'
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$jobRoot = [System.IO.Path]::GetFullPath($JobDirectory)
$outputPath = [System.IO.Path]::Combine($jobRoot, 'output.json')
$stream = $null
$bitmap = $null
$converted = $null
$code = 'OCR_FAILED'
try {
    if (-not [System.IO.Directory]::Exists($jobRoot)) { throw 'Job unavailable.' }
    $inputFiles = @([System.IO.Directory]::GetFiles($jobRoot, 'input.*'))
    if ($inputFiles.Length -ne 1) { throw 'One image is required.' }
    $inputPath = $inputFiles[0]
    if (@('.png','.jpg','.webp') -notcontains [System.IO.Path]::GetExtension($inputPath)) { throw 'Unsupported input.' }
    if (([System.IO.FileInfo]$inputPath).Length -gt 10485760) { throw 'Input too large.' }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $script:receiptAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Length -eq 1 -and
        $_.GetParameters().Length -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Wait-ReceiptOperation {
        param([object]$Operation,[Type]$ResultType)
        $task = $script:receiptAsTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
        if (-not $task.Wait(30000)) { throw 'Operation timeout.' }
        return $task.Result
    }
    $code = 'OCR_UNAVAILABLE'
    $language = New-Object Windows.Globalization.Language -ArgumentList 'en-US'
    if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($language)) { throw 'Recognizer unavailable.' }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -eq $engine) { throw 'Recognizer unavailable.' }
    $code = 'OCR_FAILED'
    $file = Wait-ReceiptOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($inputPath)) ([Windows.Storage.StorageFile])
    $stream = Wait-ReceiptOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Wait-ReceiptOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $code = 'IMAGE_DIMENSIONS'
    if ($decoder.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $decoder.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or ([long]$decoder.PixelWidth * [long]$decoder.PixelHeight) -gt 40000000) { throw 'Image exceeds recognizer limits.' }
    $code = 'OCR_FAILED'
    $bitmap = Wait-ReceiptOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $converted = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap,[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
    $recognized = Wait-ReceiptOperation ($engine.RecognizeAsync($converted)) ([Windows.Media.Ocr.OcrResult])
    $words = @()
    foreach ($line in $recognized.Lines) {
        foreach ($word in $line.Words) {
            if ($words.Count -ge 3000) { throw 'Too many words.' }
            $words += [ordered]@{text=$word.Text;bounds=[ordered]@{x=$word.BoundingRect.X;y=$word.BoundingRect.Y;width=$word.BoundingRect.Width;height=$word.BoundingRect.Height}}
        }
    }
    $angle = $null
    if ($null -ne $recognized.TextAngle) { $angle = [double]$recognized.TextAngle }
    $timer.Stop()
    $result = [ordered]@{version=1;provider='windows-media-ocr';language='en-US';width=$decoder.PixelWidth;height=$decoder.PixelHeight;elapsedMs=$timer.ElapsedMilliseconds;textAngle=$angle;words=$words}
    [System.IO.File]::WriteAllText($outputPath,($result | ConvertTo-Json -Depth 6 -Compress),(New-Object System.Text.UTF8Encoding($false)))
} catch {
    # Do not expose native errors, recognized words, source paths, or image contents.
    [System.IO.File]::WriteAllText($outputPath,('{"error":"' + $code + '"}'),(New-Object System.Text.UTF8Encoding($false)))
    exit 1
} finally {
    if ($null -ne $converted) { $converted.Dispose() }
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
