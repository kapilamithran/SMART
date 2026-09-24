# Trims PP-OCRv5 Mobile rec's final classifier to digit-relevant classes. Kept logits are bit-identical.
# Source model: onnxocr 3.1.0 (PyPI) onnxocr/models/ppocrv5/rec/rec.onnx + ppocrv5_dict.txt (PaddleOCR PP-OCRv5_mobile_rec, Apache-2.0).
# Usage: pip install onnx numpy; adjust the two paths below; python tools/trim_model.py
import onnx, numpy as np
from onnx import numpy_helper
m=onnx.load('m/onnxocr/models/ppocrv5/rec/rec.onnx')
chars=['blank']+[l.rstrip('\r\n') for l in open('m/onnxocr/models/ppocrv5/ppocrv5_dict.txt',encoding='utf-8')]+[' ']
inits={i.name:i for i in m.graph.initializer}
W=numpy_helper.to_array(inits['linear_8.w_0']); B=numpy_helper.to_array(inits['linear_8.b_0'])
print(W.shape,B.shape,len(chars))
keep_chars=list('0123456789')+['+','-','一','—','–','_','/','|','l','I','.','-']
keep=[0]; labels=['']
for ch in keep_chars:
    if ch in chars:
        i=chars.index(ch)
        if i not in keep: keep.append(i); labels.append(ch)
print(labels)
Wn=W[:,keep].astype(np.float32); Bn=B[keep].astype(np.float32)
inits['linear_8.w_0'].CopyFrom(numpy_helper.from_array(Wn,'linear_8.w_0'))
inits['linear_8.b_0'].CopyFrom(numpy_helper.from_array(Bn,'linear_8.b_0'))
# output dim metadata
for o in m.graph.output:
    d=o.type.tensor_type.shape.dim
    if len(d)==3: d[2].ClearField('dim_param'); d[2].dim_value=len(keep)
del m.graph.value_info[:]
onnx.checker.check_model(m)
onnx.save(m,'rec_digits.onnx')
import json; json.dump({'labels':labels,'source_indices':keep},open('rec_digits_labels.json','w'),ensure_ascii=False)
