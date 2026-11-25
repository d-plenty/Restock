# The text reader's models

Restock reads receipts and the fronts of packs on the phone with PaddleOCR's **PP-OCRv5 mobile**
models, run by ONNX Runtime Web through paddleocr.js. The engine and the letter list are part of the
app. The two model files are part of the Restock server's web pages; the phone and tablet apps
download them the first time the reader is used, after asking, from this folder at the `v0.14.0` tag
of this repository, and check each one against the SHA-256 below before keeping it
(`src/lib/readerModels.ts`). Don't move or change the model files at that tag.

| File | What | SHA-256 |
| --- | --- | --- |
| `ppocrv5-mobile-det.onnx` | Finds where the writing is | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `ppocrv5-mobile-rec.onnx` | Reads each bit of writing | `5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5` |
| `ppocrv5-dict.txt` | The letters it knows | `1ea29636956177e400af712d9782e7693f3fb25f98617bed10479d2965a836fd` |

- Models: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), Apache-2.0, by PaddlePaddle.
- These ONNX copies come unchanged from [OnnxOCR](https://github.com/jingsongliujing/OnnxOCR)
  (Apache-2.0), version 4.0.0 on PyPI (`onnxocr/models/ppocrv5/`).
- To check them: `sha256sum src/assets/reader/*` (the letter list keeps its Windows line endings, so `.gitattributes` marks it binary)
