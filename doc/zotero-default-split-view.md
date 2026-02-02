原始默认的zotero split-view为：

```
<div id="split-view">
    <div id="primary-view" class="primary-view">
        <iframe src="pdf/web/viewer.html" class="loaded">

            <html dir="ltr" mozdisallowselectionprint="" style="--viewer-container-height: 1278px; --background-color: #FFFFFF;" data-toolbar-density="normal" data-color-scheme="light"><head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
                <meta name="google" content="notranslate">
                <title>PDF.js viewer</title>

            <!-- This snippet is used in production (included from viewer.html) -->
            <script src="../build/pdf.mjs" type="module"></script>

                <link rel="stylesheet" href="viewer.css">

            <script src="viewer.mjs" type="module"></script>
            ...

        </iframe>
    </div>
    <div id="secondary-view" class="secondary-view">
        <iframe src="pdf/web/viewer.html" class="loaded">
        </iframe>
    </div>
</div>


```





