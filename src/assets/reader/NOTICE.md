# The text reader's models

Restock reads receipts and the fronts of packs on the phone with PaddleOCR's **PP-OCRv5 mobile**
models, run by ONNX Runtime Web through paddleocr.js. Nothing here is downloaded at run time: these
files are part of the app.

| File | What | SHA-256 |
| --- | --- | --- |
| `ppocrv5-mobile-det.onnx` | Finds where the writing is | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `ppocrv5-mobile-rec.onnx` | Reads each bit of writing | `5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5` |
| `ppocrv5-dict.txt` | The letters it knows | `1ea29636956177e400af712d9782e7693f3fb25f98617bed10479d2965a836fd` |

- Models: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), Apache-2.0, by PaddlePaddle.
- These ONNX copies come unchanged from [OnnxOCR](https://github.com/jingsongliujing/OnnxOCR)
  (Apache-2.0), version 4.0.0 on PyPI (`onnxocr/models/ppocrv5/`).
- To check them: `sha256sum src/assets/reader/*` (the letter list keeps its Windows line endings, so `.gitattributes` marks it binary)
