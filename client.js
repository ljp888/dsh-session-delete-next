/**
 * dsh-session-delete-next — Client half (Web bundle).
 *
 * Loaded as this package's `./client` artifact: the Host reads these bytes and
 * serves them at /plugins/dsh-session-delete-next/client.js. The only top-level
 * side effect is the module-loader registration below.
 *
 * Two contributions, both official slots:
 *   - `sidebar.workspaces.session.menu.item` — a "Delete session" row in the
 *     session's "…" menu, after the shipped pin/rename/fork/archive rows;
 *   - `shell.overlay` — the confirmation dialog, kept outside the menu so it
 *     survives the menu closing.
 *
 * The delete itself runs in the Host half over one same-origin route.
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-delete-next',
	factory(require) {
		const React = require('react');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		const h = React.createElement;

		const TAG = '[dsh-session-delete-next]';

		/** Locale namespace owned by this plugin. */
		const NS = 'session-delete-next';

		/** The Host half's only entry point. */
		const ENDPOINT = '/dsh-session-delete-next/delete';

		/** Primitives this plugin renders with; a host without them registers nothing. */
		const REQUIRED = ['Button', 'Modal', 'MenuItemButton', 'IconTrashOutlineRegular'];

		const DICTS = {
			zh: {
				action: '删除会话',
				dialogTitle: '删除会话',
				dialogBody: '将永久删除会话“{title}”的全部本地记录（含日志文件），不可恢复。',
				confirm: '永久删除',
				cancel: '取消',
				busy: '删除中…',
				close: '关闭',
				errLive: '该会话正在本进程中运行或已被打开，无法删除。请先关闭它，或重启 DSH 后再试。',
				errPending: '该会话已创建但尚未写入磁盘，无法删除。请稍后重试。',
				errNoStore: '无法确认该会话是否正在运行（会话服务不可用），为安全起见已拒绝删除。',
				errMissing: '未找到该会话的持久化记录（可能它从未写入磁盘）。',
				errNetwork: '请求失败：无法连接到 DSH 主机。',
				errOrigin: '请求被拒绝：来源校验未通过。',
				errPath: '已拒绝删除：会话路径未通过安全校验。',
				errRemove: '删除会话文件失败：{detail}',
				errUnknown: '删除失败（{code}）。'
			},
			en: {
				action: 'Delete session',
				dialogTitle: 'Delete session',
				dialogBody: 'Permanently delete all local records of session “{title}”, including its log file. This cannot be undone.',
				confirm: 'Delete permanently',
				cancel: 'Cancel',
				busy: 'Deleting…',
				close: 'Close',
				errLive: 'This session is running or open in this process and cannot be deleted. Close it, or restart DSH and retry.',
				errPending: 'This session was created but has not been written to disk yet, so it cannot be deleted. Retry shortly.',
				errNoStore: 'Whether this session is running could not be determined (the session service is unavailable); the deletion was refused to stay safe.',
				errMissing: 'No persisted record was found for this session.',
				errNetwork: 'Request failed: the DSH host is unreachable.',
				errOrigin: 'Request refused: the origin check did not pass.',
				errPath: 'Refused: the session path did not pass the safety check.',
				errRemove: 'Failed to remove the session files: {detail}',
				errUnknown: 'Delete failed ({code}).'
			}
		};

		/**
		 * The one pending confirmation, shared by the menu row that raises it and
		 * the overlay that renders it. A plain external store keeps both
		 * components free of any parent relationship.
		 */
		const pending = { value: null, listeners: new Set() };

		/** Publish a new pending request (or null to dismiss). */
		function setPending(next) {
			pending.value = next;
			for (const listener of Array.from(pending.listeners)) {
				try {
					listener();
				} catch (error) {
					console.error(TAG, error);
				}
			}
		}

		/** Subscribe to pending-request changes. */
		function subscribePending(listener) {
			pending.listeners.add(listener);
			return () => {
				pending.listeners.delete(listener);
			};
		}

		/** Read the pending request. */
		function readPending() {
			return pending.value;
		}

		/** Ask the Host half to delete one session. */
		async function callDelete(sessionId) {
			let response;
			try {
				response = await fetch(ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId })
				});
			} catch {
				return { ok: false, code: 'network', detail: '' };
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (payload === null || typeof payload !== 'object') {
				return { ok: false, code: 'network', detail: 'HTTP ' + String(response.status) };
			}
			return {
				ok: payload.ok === true,
				code: typeof payload.code === 'string' ? payload.code : 'unknown',
				detail: typeof payload.detail === 'string' ? payload.detail : ''
			};
		}

		/** Turn one failure outcome into user-facing text. */
		function messageFor(outcome, t) {
			switch (outcome.code) {
				case 'live':
					return t('errLive');
				case 'pending':
					return t('errPending');
				case 'no-session-store':
					return t('errNoStore');
				case 'missing':
					return t('errMissing');
				case 'network':
					return t('errNetwork');
				case 'origin':
					return t('errOrigin');
				case 'bad-path':
					return t('errPath');
				case 'rm-failed':
				case 'stat-failed':
				case 'list-failed':
					return t('errRemove', { detail: outcome.detail });
				default:
					return t('errUnknown', { code: outcome.code });
			}
		}

		/**
		 * The `sidebar.workspaces.session.menu.item` row. The slot's own
		 * declaration injects `useMenuOpenState`, so the row can dismiss the menu
		 * before handing off to the overlay.
		 */
		function DeleteSessionMenuItem(props) {
			const sessionId = props.sessionId;
			const displayTitle = typeof props.displayTitle === 'string' ? props.displayTitle : '';
			const t = props.t;
			const [, setMenuOpen] = props.useMenuOpenState();

			const onSelect = React.useCallback(() => {
				setMenuOpen(false);
				setPending({ sessionId, displayTitle });
			}, [setMenuOpen, sessionId, displayTitle]);

			return h(
				primitives.MenuItemButton,
				{
					separatorBefore: true,
					danger: true,
					icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
					onSelect
				},
				t('action')
			);
		}

		/** One request's dialog; in-flight and error state die with it. */
		function DeleteSessionConfirm(props) {
			const request = props.request;
			const t = props.t;
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState('');

			const close = React.useCallback(() => {
				if (busy) return;
				setPending(null);
			}, [busy]);

			const confirm = React.useCallback(() => {
				setBusy(true);
				setError('');
				callDelete(request.sessionId).then((outcome) => {
					setBusy(false);
					if (outcome.ok) {
						setPending(null);
						return;
					}
					setError(messageFor(outcome, t));
				});
			}, [request, t]);

			const title = request.displayTitle === '' ? request.sessionId : request.displayTitle;
			const alert = error === ''
				? null
				: h(
					'div',
					{
						role: 'alert',
						style: {
							color: 'var(--dsw-alias-state-error-primary)',
							fontSize: '12px',
							lineHeight: '18px',
							wordBreak: 'break-word'
						}
					},
					error
				);

			return h(
				primitives.Modal,
				{
					open: true,
					onClose: close,
					closeLabel: t('close'),
					title: t('dialogTitle'),
					description: t('dialogBody', { title }),
					footer: h(
						React.Fragment,
						null,
						h(
							primitives.Button,
							{ variant: 'outline', disabled: busy, onClick: close },
							t('cancel')
						),
						h(
							primitives.Button,
							{
								variant: 'outline',
								disabled: busy,
								onClick: confirm,
								style: { color: 'var(--dsw-alias-state-error-primary)' }
							},
							busy ? t('busy') : t('confirm')
						)
					)
				},
				alert
			);
		}

		/** The `shell.overlay` entry: nothing while no confirmation is pending. */
		function DeleteSessionOverlay(props) {
			const request = React.useSyncExternalStore(subscribePending, readPending, readPending);
			if (request === null) return null;
			return h(DeleteSessionConfirm, { key: request.sessionId, request, t: props.t });
		}

		/** The plugin body: registers the locale dictionary and both slots. */
		function apply(ctx) {
			ctx.effect(
				() => ctx.locale.register(NS, DICTS),
				'dsh-session-delete-next: locale dictionaries'
			);

			const missing = REQUIRED.filter((name) => primitives[name] === undefined);
			if (missing.length > 0) {
				console.warn(TAG + ': host UI primitives unavailable, nothing registered:', missing.join(', '));
				return;
			}

			ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
				name: 'sidebar.workspaces.session.menu.item',
				id: 'session-delete-next',
				order: 500,
				locale: NS
			}, DeleteSessionMenuItem));

			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'session-delete-next',
				locale: NS
			}, DeleteSessionOverlay));

			ctx.effect(() => () => {
				setPending(null);
			}, 'dsh-session-delete-next: pending cleanup');
		}

		return { inject: ['slots', 'locale'], apply };
	}
});
