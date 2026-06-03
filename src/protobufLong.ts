import Long from 'long';
import protobuf from 'protobufjs';

type LongCtor = typeof Long;
const candidate = Long as unknown as LongCtor & { default?: LongCtor };
const longCtor = typeof candidate.fromNumber === 'function' ? candidate : candidate.default;

if (longCtor && protobuf.util.Long !== longCtor) {
  protobuf.util.Long = longCtor;
  protobuf.configure();
}
