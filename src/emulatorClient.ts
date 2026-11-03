import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { RunningEmulator } from './discovery';

type ControllerCtor = new (address: string, credentials: grpc.ChannelCredentials, options?: object) => grpc.Client;

let controllerCtor: ControllerCtor | undefined;

function loadController(protoPath: string): ControllerCtor {
  if (!controllerCtor) {
    const definition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = grpc.loadPackageDefinition(definition) as any;
    controllerCtor = pkg.android.emulation.control.EmulatorController as ControllerCtor;
  }
  return controllerCtor;
}

export type SkinRotation = 'PORTRAIT' | 'LANDSCAPE' | 'REVERSE_PORTRAIT' | 'REVERSE_LANDSCAPE';

export interface ImageMessage {
  format: {
    width: number;
    height: number;
    rotation?: { rotation: SkinRotation } | null;
  };
  image: Buffer;
  seq: number;
}

/** Thin promise-based wrapper over the emulator's EmulatorController gRPC service. */
export class EmulatorClient {
  private readonly client: any;

  constructor(readonly emulator: RunningEmulator, protoPath: string) {
    const Ctor = loadController(protoPath);
    this.client = new Ctor(`localhost:${emulator.grpcPort}`, grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': -1,
      'grpc.max_send_message_length': -1,
    });
  }

  private metadata(): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.emulator.grpcToken) {
      md.add('authorization', `Bearer ${this.emulator.grpcToken}`);
    }
    return md;
  }

  call<T = any>(method: string, request: object = {}, timeoutMs = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      this.client[method](request, this.metadata(), { deadline: Date.now() + timeoutMs }, (err: grpc.ServiceError | null, res: T) =>
        err ? reject(err) : resolve(res),
      );
    });
  }

  streamScreenshot(width: number, height: number): grpc.ClientReadableStream<ImageMessage> {
    return this.client.streamScreenshot({ format: 'RGB888', width, height, display: 0 }, this.metadata());
  }

  streamNotification(): grpc.ClientReadableStream<any> {
    return this.client.streamNotification({}, this.metadata());
  }

  /** Ordered client-streaming input channel (touch, mouse, keys, wheel). */
  openInputStream(onDone: (err: grpc.ServiceError | null) => void): grpc.ClientWritableStream<object> {
    return this.client.streamInputEvent(this.metadata(), (err: grpc.ServiceError | null) => onDone(err));
  }

  close(): void {
    this.client.close();
  }
}

export const GrpcStatus = grpc.status;
