import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as zmq from 'zeromq';
import {
  JupyterProtocol,
  JupyterMessage,
  StreamContent,
  DisplayDataContent,
  ErrorContent,
  StatusContent,
  ExecuteReplyContent,
} from './JupyterProtocol';

export type KernelState = 'idle' | 'busy' | 'starting' | 'dead' | 'disconnected';

export interface KernelOutput {
  type: 'stdout' | 'stderr' | 'result' | 'display' | 'error' | 'status';
  content: string;
  mimeType?: string;
  executionCount?: number;
}

export interface ConnectionInfo {
  shell_port: number;
  iopub_port: number;
  stdin_port: number;
  control_port: number;
  hb_port: number;
  ip: string;
  key: string;
  transport: string;
  signature_scheme: string;
  kernel_name: string;
}

export class KernelManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private protocol: JupyterProtocol | null = null;
  private connectionFile: string | null = null;
  private connectionInfo: ConnectionInfo | null = null;

  private shellSocket: zmq.Dealer | null = null;
  private iopubSocket: zmq.Subscriber | null = null;
  private controlSocket: zmq.Dealer | null = null;

  private state: KernelState = 'disconnected';
  private executionCount = 0;
  private pythonPath: string;
  private pendingExecutions = new Map<string, {
    resolve: () => void;
    outputs: KernelOutput[];
  }>();

  constructor(pythonPath: string) {
    super();
    this.pythonPath = pythonPath;
  }

  getState(): KernelState {
    return this.state;
  }

  getExecutionCount(): number {
    return this.executionCount;
  }

  private setState(newState: KernelState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState);
    }
  }

  async start(): Promise<void> {
    if (this.process) {
      await this.shutdown();
    }

    this.setState('starting');

    // Create a temporary connection file
    const tmpDir = os.tmpdir();
    this.connectionFile = path.join(tmpDir, `kernel-${Date.now()}.json`);

    // Start the kernel process
    this.process = spawn(this.pythonPath, [
      '-m', 'ipykernel_launcher',
      '-f', this.connectionFile,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', () => {
      // Kernel stdout - can be used for debugging
    });

    this.process.stderr?.on('data', () => {
      // Kernel stderr - can be used for debugging
    });

    this.process.on('exit', () => {
      this.setState('dead');
      this.cleanup();
    });

    this.process.on('error', (err) => {
      this.setState('dead');
      this.emit('error', err);
    });

    // Wait for the connection file to be created
    await this.waitForConnectionFile();

    // Read connection info
    const content = await fs.readFile(this.connectionFile, 'utf-8');
    this.connectionInfo = JSON.parse(content) as ConnectionInfo;

    // Initialize protocol with the key
    this.protocol = new JupyterProtocol(this.connectionInfo.key);

    // Connect ZeroMQ sockets
    await this.connectSockets();

    // Start listening for iopub messages
    this.startIopubListener();

    // Request kernel info to verify connection
    await this.requestKernelInfo();

    this.setState('idle');
  }

  private async waitForConnectionFile(): Promise<void> {
    const maxAttempts = 50;
    const delay = 100;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        await fs.access(this.connectionFile!);
        // Wait a bit more to ensure the file is fully written
        await new Promise((resolve) => setTimeout(resolve, 100));
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Timeout waiting for kernel connection file');
  }

  private async connectSockets(): Promise<void> {
    if (!this.connectionInfo) throw new Error('No connection info');

    const { ip, transport, shell_port, iopub_port, control_port } = this.connectionInfo;
    const baseUrl = `${transport}://${ip}`;

    // Shell socket (DEALER)
    this.shellSocket = new zmq.Dealer();
    this.shellSocket.routingId = `shell-${Date.now()}`;
    await this.shellSocket.connect(`${baseUrl}:${shell_port}`);

    // IOPub socket (SUB)
    this.iopubSocket = new zmq.Subscriber();
    await this.iopubSocket.connect(`${baseUrl}:${iopub_port}`);
    this.iopubSocket.subscribe('');

    // Control socket (DEALER)
    this.controlSocket = new zmq.Dealer();
    this.controlSocket.routingId = `control-${Date.now()}`;
    await this.controlSocket.connect(`${baseUrl}:${control_port}`);
  }

  private startIopubListener(): void {
    if (!this.iopubSocket || !this.protocol) return;

    const handleMessages = async () => {
      try {
        for await (const frames of this.iopubSocket!) {
          const buffers = frames.map((f: Uint8Array) => Buffer.from(f));
          const msg = this.protocol!.parseMessage(buffers);
          if (msg) {
            this.handleIopubMessage(msg);
          }
        }
      } catch (err) {
        if (this.state !== 'dead' && this.state !== 'disconnected') {
          this.emit('error', err);
        }
      }
    };

    handleMessages();
  }

  private handleIopubMessage(msg: JupyterMessage): void {
    const parentMsgId = (msg.parent_header as { msg_id?: string }).msg_id;

    if (this.protocol!.isStatus(msg)) {
      const content = msg.content as StatusContent;
      if (content.execution_state === 'busy') {
        this.setState('busy');
      } else if (content.execution_state === 'idle') {
        this.setState('idle');
        // Complete any pending execution
        if (parentMsgId && this.pendingExecutions.has(parentMsgId)) {
          const pending = this.pendingExecutions.get(parentMsgId)!;
          pending.resolve();
          this.pendingExecutions.delete(parentMsgId);
        }
      }
      return;
    }

    // Route output to pending execution or emit globally
    const emitOutput = (output: KernelOutput) => {
      if (parentMsgId && this.pendingExecutions.has(parentMsgId)) {
        this.pendingExecutions.get(parentMsgId)!.outputs.push(output);
      }
      this.emit('output', output, parentMsgId);
    };

    if (this.protocol!.isStream(msg)) {
      const content = msg.content as StreamContent;
      emitOutput({
        type: content.name === 'stdout' ? 'stdout' : 'stderr',
        content: content.text,
      });
    } else if (this.protocol!.isDisplayData(msg)) {
      const content = msg.content as DisplayDataContent;
      const data = content.data;

      // Prioritize rich formats
      if (data['image/png']) {
        emitOutput({ type: 'display', content: data['image/png'], mimeType: 'image/png' });
      } else if (data['image/jpeg']) {
        emitOutput({ type: 'display', content: data['image/jpeg'], mimeType: 'image/jpeg' });
      } else if (data['text/html']) {
        emitOutput({ type: 'display', content: data['text/html'], mimeType: 'text/html' });
      } else if (data['application/json']) {
        emitOutput({
          type: 'display',
          content: JSON.stringify(JSON.parse(data['application/json']), null, 2),
          mimeType: 'application/json',
        });
      } else if (data['text/plain']) {
        emitOutput({ type: 'result', content: data['text/plain'] });
      }
    } else if (this.protocol!.isError(msg)) {
      const content = msg.content as ErrorContent;
      const traceback = content.traceback.join('\n');
      emitOutput({ type: 'error', content: traceback });
    } else if (this.protocol!.isExecuteReply(msg)) {
      const content = msg.content as ExecuteReplyContent;
      if (content.execution_count) {
        this.executionCount = content.execution_count;
      }
    }
  }

  private async requestKernelInfo(): Promise<void> {
    if (!this.shellSocket || !this.protocol) return;

    const msg = this.protocol.createKernelInfoRequest();
    const frames = this.protocol.serializeMessage(msg);
    await this.shellSocket.send(frames);

    // Wait for reply
    const reply = await this.shellSocket.receive();
    const buffers = reply.map((f: Uint8Array) => Buffer.from(f));
    const replyMsg = this.protocol.parseMessage(buffers);

    if (replyMsg && this.protocol.isKernelInfoReply(replyMsg)) {
      this.emit('kernelInfo', replyMsg.content);
    }
  }

  async execute(code: string): Promise<{ msgId: string; outputs: KernelOutput[] }> {
    if (!this.shellSocket || !this.protocol) {
      throw new Error('Kernel not started');
    }

    const msg = this.protocol.createExecuteRequest(code);
    const msgId = msg.header.msg_id;
    const frames = this.protocol.serializeMessage(msg);

    // Set up pending execution tracking
    const outputs: KernelOutput[] = [];
    const promise = new Promise<void>((resolve) => {
      this.pendingExecutions.set(msgId, { resolve, outputs });
    });

    // Send the execute request
    await this.shellSocket.send(frames);

    // Wait for shell reply
    const reply = await this.shellSocket.receive();
    const buffers = reply.map((f: Uint8Array) => Buffer.from(f));
    this.protocol.parseMessage(buffers);

    // Wait for execution to complete (idle status)
    await promise;

    return { msgId, outputs };
  }

  async interrupt(): Promise<void> {
    if (this.process && this.process.pid) {
      // Send SIGINT to the kernel process
      process.kill(this.process.pid, 'SIGINT');

      // Also try via control channel
      if (this.controlSocket && this.protocol) {
        const msg = this.protocol.createInterruptRequest();
        const frames = this.protocol.serializeMessage(msg);
        await this.controlSocket.send(frames);
      }
    }
  }

  async restart(): Promise<void> {
    await this.shutdown();
    await this.start();
  }

  async shutdown(): Promise<void> {
    this.setState('dead');

    // Close ZeroMQ sockets
    if (this.shellSocket) {
      this.shellSocket.close();
      this.shellSocket = null;
    }
    if (this.iopubSocket) {
      this.iopubSocket.close();
      this.iopubSocket = null;
    }
    if (this.controlSocket) {
      this.controlSocket.close();
      this.controlSocket = null;
    }

    // Kill the kernel process
    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Remove connection file
    if (this.connectionFile) {
      try {
        await fs.unlink(this.connectionFile);
      } catch { /* ignore */ }
      this.connectionFile = null;
    }
    this.connectionInfo = null;
    this.protocol = null;
    this.pendingExecutions.clear();
  }
}
