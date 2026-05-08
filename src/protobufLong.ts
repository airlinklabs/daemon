import protobuf from 'protobufjs';
import Long from 'long';

type LongCtor = typeof Long;
const candidate = Long as unknown as LongCtor & { default?: LongCtor };
const longCtor = typeof candidate.fromNumber === 'function' ? candidate : candidate.default;

if (longCtor && protobuf.util.Long !== longCtor) {
  protobuf.util.Long = longCtor;
  protobuf.configure();
}
