import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

export interface JupyterHeader {
  msg_id: string;
  msg_type: string;
  username: string;
  session: string;
  date: string;
  version: string;
}

export interface JupyterMessage<T = unknown> {
  header: JupyterHeader;
  parent_header: JupyterHeader | Record<string, never>;
  metadata: Record<string, unknown>;
  content: T;
  buffers?: Buffer[];
}

export interface ExecuteRequestContent {
  code: string;
  silent: boolean;
  store_history: boolean;
  user_expressions: Record<string, string>;
  allow_stdin: boolean;
  stop_on_error: boolean;
}

export interface ExecuteReplyContent {
  status: 'ok' | 'error' | 'abort';
  execution_count: number;
  user_expressions?: Record<string, unknown>;
  payload?: unknown[];
  // Error fields
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface StreamContent {
  name: 'stdout' | 'stderr';
  text: string;
}

export interface DisplayDataContent {
  data: Record<string, string>;
  metadata: Record<string, unknown>;
  transient?: { display_id?: string };
}

export interface ErrorContent {
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface StatusContent {
  execution_state: 'busy' | 'idle' | 'starting';
}

export interface KernelInfoReplyContent {
  protocol_version: string;
  implementation: string;
  implementation_version: string;
  language_info: {
    name: string;
    version: string;
    mimetype: string;
    file_extension: string;
  };
  banner: string;
  status: 'ok';
}

export type MessageType =
  | 'execute_request'
  | 'execute_reply'
  | 'stream'
  | 'display_data'
  | 'execute_result'
  | 'error'
  | 'status'
  | 'kernel_info_request'
  | 'kernel_info_reply'
  | 'shutdown_request'
  | 'shutdown_reply'
  | 'interrupt_request'
  | 'interrupt_reply';

export class JupyterProtocol {
  private sessionId: string;
  private username: string;
  private key: string;

  constructor(key: string = '') {
    this.sessionId = uuidv4();
    this.username = 'promptbook';
    this.key = key;
  }

  createHeader(msgType: MessageType): JupyterHeader {
    return {
      msg_id: uuidv4(),
      msg_type: msgType,
      username: this.username,
      session: this.sessionId,
      date: new Date().toISOString(),
      version: '5.3',
    };
  }

  createMessage<T>(msgType: MessageType, content: T, parentHeader?: JupyterHeader): JupyterMessage<T> {
    return {
      header: this.createHeader(msgType),
      parent_header: parentHeader || {},
      metadata: {},
      content,
    };
  }

  createExecuteRequest(code: string, silent = false): JupyterMessage<ExecuteRequestContent> {
    return this.createMessage('execute_request', {
      code,
      silent,
      store_history: !silent,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    });
  }

  createKernelInfoRequest(): JupyterMessage<Record<string, never>> {
    return this.createMessage('kernel_info_request', {});
  }

  createShutdownRequest(restart = false): JupyterMessage<{ restart: boolean }> {
    return this.createMessage('shutdown_request', { restart });
  }

  createInterruptRequest(): JupyterMessage<Record<string, never>> {
    return this.createMessage('interrupt_request', {});
  }

  sign(parts: Buffer[]): string {
    if (!this.key) return '';
    const hmac = crypto.createHmac('sha256', this.key);
    for (const part of parts) {
      hmac.update(part);
    }
    return hmac.digest('hex');
  }

  serializeMessage(msg: JupyterMessage): Buffer[] {
    const header = Buffer.from(JSON.stringify(msg.header));
    const parentHeader = Buffer.from(JSON.stringify(msg.parent_header));
    const metadata = Buffer.from(JSON.stringify(msg.metadata));
    const content = Buffer.from(JSON.stringify(msg.content));

    const signature = this.sign([header, parentHeader, metadata, content]);

    return [
      Buffer.from('<IDS|MSG>'),
      Buffer.from(signature),
      header,
      parentHeader,
      metadata,
      content,
    ];
  }

  parseMessage(frames: Buffer[]): JupyterMessage | null {
    // Find the delimiter
    let delimiterIndex = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].toString() === '<IDS|MSG>') {
        delimiterIndex = i;
        break;
      }
    }

    if (delimiterIndex === -1 || frames.length < delimiterIndex + 6) {
      return null;
    }

    const signature = frames[delimiterIndex + 1].toString();
    const header = JSON.parse(frames[delimiterIndex + 2].toString()) as JupyterHeader;
    const parentHeader = JSON.parse(frames[delimiterIndex + 3].toString()) as JupyterHeader | Record<string, never>;
    const metadata = JSON.parse(frames[delimiterIndex + 4].toString()) as Record<string, unknown>;
    const content = JSON.parse(frames[delimiterIndex + 5].toString()) as unknown;

    // Verify signature if key is set
    if (this.key && signature) {
      const parts = [
        frames[delimiterIndex + 2],
        frames[delimiterIndex + 3],
        frames[delimiterIndex + 4],
        frames[delimiterIndex + 5],
      ];
      const expectedSig = this.sign(parts);
      if (signature !== expectedSig) {
        console.warn('Message signature mismatch');
      }
    }

    return {
      header,
      parent_header: parentHeader,
      metadata,
      content,
      buffers: frames.slice(delimiterIndex + 6),
    };
  }

  isExecuteReply(msg: JupyterMessage): msg is JupyterMessage<ExecuteReplyContent> {
    return msg.header.msg_type === 'execute_reply';
  }

  isStream(msg: JupyterMessage): msg is JupyterMessage<StreamContent> {
    return msg.header.msg_type === 'stream';
  }

  isDisplayData(msg: JupyterMessage): msg is JupyterMessage<DisplayDataContent> {
    return msg.header.msg_type === 'display_data' || msg.header.msg_type === 'execute_result';
  }

  isError(msg: JupyterMessage): msg is JupyterMessage<ErrorContent> {
    return msg.header.msg_type === 'error';
  }

  isStatus(msg: JupyterMessage): msg is JupyterMessage<StatusContent> {
    return msg.header.msg_type === 'status';
  }

  isKernelInfoReply(msg: JupyterMessage): msg is JupyterMessage<KernelInfoReplyContent> {
    return msg.header.msg_type === 'kernel_info_reply';
  }
}
