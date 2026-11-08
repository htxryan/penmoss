# Regenerate: uv run --with onnx --with numpy python gen.py (from this folder).
# A tiny stand-in for EmbeddingGemma's ONNX graph: input_ids and attention_mask [batch, seq] int64 in,
# sentence_embedding [batch, 4] float out = masked mean of a 16x4 embedding table (unnormalised).
import onnx, numpy as np
from onnx import helper as h, TensorProto as T, numpy_helper as nh
table = (np.arange(64, dtype=np.float32).reshape(16, 4) % 7) - 3
nodes = [
  h.make_node('Gather', ['table', 'input_ids'], ['emb'], axis=0),
  h.make_node('Cast', ['attention_mask'], ['maskf'], to=T.FLOAT),
  h.make_node('Unsqueeze', ['maskf', 'axes'], ['mask3']),
  h.make_node('Mul', ['emb', 'mask3'], ['masked']),
  h.make_node('ReduceSum', ['masked', 'one'], ['summed'], keepdims=0),
  h.make_node('ReduceSum', ['mask3', 'one'], ['count'], keepdims=0),
  h.make_node('Div', ['summed', 'count'], ['sentence_embedding']),
]
g = h.make_graph(nodes, 'tiny',
  [h.make_tensor_value_info('input_ids', T.INT64, ['b', 's']), h.make_tensor_value_info('attention_mask', T.INT64, ['b', 's'])],
  [h.make_tensor_value_info('sentence_embedding', T.FLOAT, ['b', 4])],
  [nh.from_array(table, 'table'), nh.from_array(np.array([2], dtype=np.int64), 'axes'), nh.from_array(np.array([1], dtype=np.int64), 'one')])
import os
for f in ("onnx/model.onnx", "onnx/model.onnx_data"):
  if os.path.exists(f): os.remove(f)  # onnx.save appends to existing external data
m = h.make_model(g, opset_imports=[h.make_opsetid('', 17)]); m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, 'onnx/model.onnx', save_as_external_data=True, location='model.onnx_data', size_threshold=64)  # the table only; shape inputs stay inline
