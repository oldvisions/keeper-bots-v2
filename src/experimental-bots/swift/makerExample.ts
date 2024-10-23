import {
	DriftClient,
	getUserAccountPublicKey,
	getUserStatsAccountPublicKey,
	PublicKey,
	UserMap,
} from '@drift-labs/sdk';
import { RuntimeSpec } from 'src/metrics';
import WebSocket from 'ws';
import nacl from 'tweetnacl';
import { decodeUTF8 } from 'tweetnacl-util';

export class SwiftMaker {
	interval: NodeJS.Timeout | null = null;
	private ws: WebSocket | null = null;
	private heartbeatTimeout: NodeJS.Timeout | null = null;
	private readonly heartbeatIntervalMs = 30000;
	constructor(
		private driftClient: DriftClient,
		private userMap: UserMap,
		runtimeSpec: RuntimeSpec
	) {
		if (runtimeSpec.driftEnv != 'devnet') {
			throw new Error('SwiftMaker only works on devnet');
		}
	}

	async init() {
		await this.subscribeWs();
	}

	async subscribeWs() {
		const keypair = this.driftClient.wallet.payer!;
		const ws = new WebSocket(
			`wss://master.swift.drift.trade/ws?pubkey=` + keypair.publicKey.toBase58()
		);

		ws.on('open', async () => {
			console.log('Connected to the server');
			this.startHeartbeatTimer();

			ws.on('message', async (data: WebSocket.Data) => {
				const message = JSON.parse(data.toString());
				console.log(message);

				this.startHeartbeatTimer();

				if (message['channel'] === 'auth' && message['nonce'] != null) {
					const messageBytes = decodeUTF8(message['nonce']);
					const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
					const signatureBase64 = Buffer.from(signature).toString('base64');
					ws.send(
						JSON.stringify({
							pubkey: keypair.publicKey.toBase58(),
							signature: signatureBase64,
						})
					);
				}

				if (
					message['channel'] === 'auth' &&
					message['message'] === 'Authenticated'
				) {
					ws.send(
						JSON.stringify({
							action: 'subscribe',
							market_type: 'perp',
							market_name: 'SOL-PERP',
						})
					);
				}

				if (message['order'] && this.driftClient.isSubscribed) {
					const order = JSON.parse(message['order']);
					const takerAuthority = new PublicKey(order['taker_authority']);
					const takerSubaccountId = order['taker_sub_account_id'] ?? 0;
					const takerUserPubkey = await getUserAccountPublicKey(
						this.driftClient.program.programId,
						takerAuthority,
						takerSubaccountId
					);
					const takerUserAccount = (
						await this.userMap.mustGet(takerUserPubkey.toString())
					).getUserAccount();
					const ixs = await this.driftClient.getPlaceSwiftTakerPerpOrderIxs(
						Buffer.from(order['swift_message'], 'base64'),
						Buffer.from(order['swift_signature'], 'base64'),
						Buffer.from(order['order_message'], 'base64'),
						Buffer.from(order['order_signature'], 'base64'),
						order['market_index'],
						{
							taker: takerUserPubkey,
							takerUserAccount,
							takerStats: getUserStatsAccountPublicKey(
								this.driftClient.program.programId,
								takerUserAccount.authority
							),
						}
					);
					const tx = await this.driftClient.txSender.getVersionedTransaction(
						ixs,
						[this.driftClient.lookupTableAccount],
						undefined,
						undefined,
						await this.driftClient.connection.getLatestBlockhash()
					);

					this.driftClient.txSender
						.sendVersionedTransaction(tx)
						.then((response) => {
							console.log(response);
						});
				}
			});

			ws.on('close', () => {
				console.log('Disconnected from the server');
				this.reconnect();
			});

			ws.on('error', (error: Error) => {
				console.error('WebSocket error:', error);
				this.reconnect();
			});
		});

		this.ws = ws;
	}

	public async healthCheck() {
		return true;
	}

	private startHeartbeatTimer() {
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
		}
		this.heartbeatTimeout = setTimeout(() => {
			console.warn('No heartbeat received within 30 seconds, reconnecting...');
			this.reconnect();
		}, this.heartbeatIntervalMs);
	}

	private reconnect() {
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.terminate();
		}

		console.log('Reconnecting to WebSocket...');
		setTimeout(() => {
			this.subscribeWs();
		}, 1000);
	}
}