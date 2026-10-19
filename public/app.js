(() => {
	'use strict';

	const $ = (id) => document.getElementById(id);

	const state = {
		releases: [],
		release: null, // the active full release object
		job: null, // live job snapshot for the active release (from polling)
		pollTimer: null,
		lastRenderedNote: '',
	};

	const settings = {
		apiKey: '',
		baseUrl: '',
		model: '',
		defaultRepo: '',
		productName: '',
	};

	const defaults = {
		baseUrl: 'https://api.z.ai/api/coding/paas/v4',
		model: 'glm-5.3-flash',
	};

	const ACTIVE_STATUSES = ['fetching', 'generating'];
	const isBusyStatus = (status) => ACTIVE_STATUSES.includes(status);

	const fmtNum = (n) => n.toLocaleString('en-US');
	const fmtSecs = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

	/* ---------- small helpers ---------- */

	const postJson = async (url, body, method = 'POST') => {
		const response = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		});
		const data = await response.json().catch(() => null);
		if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
		return data;
	};

	let toastTimer = null;
	const toast = (message) => {
		const el = $('toast');
		el.textContent = message;
		el.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
	};

	const setHint = (el, message, tone) => {
		el.textContent = message;
		if (tone) el.dataset.tone = tone;
		else delete el.dataset.tone;
	};

	const setStatus = (message, tone) => {
		$('output-status').classList.remove('is-loading');
		setHint($('output-status'), message, tone);
	};

	const effectiveRepo = () => (state.release?.repo || '').trim()
		.replace(/^https?:\/\/github\.com\//i, '')
		.replace(/\.git$/i, '');

	/* ---------- shared tooltip (labels as chips, or plain text) ---------- */

	let chipTooltipHideTimer = null;
	let chipTooltipAnchor = null;
	const hideChipTooltip = () => {
		chipTooltipAnchor = null;
		$('chip-tooltip').hidden = true;
	};
	const showChipTooltip = (anchor, content, mode = 'chips') => {
		const el = $('chip-tooltip');
		clearTimeout(chipTooltipHideTimer);
		chipTooltipAnchor = anchor;
		el.replaceChildren();
		el.classList.toggle('is-text', mode === 'text');
		if (mode === 'text') {
			const span = document.createElement('span');
			span.className = 'tooltip-text';
			span.textContent = content;
			el.appendChild(span);
		} else {
			for (const label of content) {
				const chip = document.createElement('span');
				chip.className = 'label-chip';
				chip.textContent = label;
				el.appendChild(chip);
			}
		}
		el.hidden = false;
		const rect = anchor.getBoundingClientRect();
		const above = rect.top > el.offsetHeight + 12;
		el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
		el.style.top = `${above ? rect.top - el.offsetHeight - 6 : rect.bottom + 6}px`;
	};
	// safety net: if the pointer ends up outside both the anchor and the tooltip, close it —
	// guarantees dismissal even when a leave event is missed (row re-render, browser quirk)
	const pointerInRect = (x, y, rect) =>
		x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4;
	const pointerOverTooltipArea = (x, y) => {
		const tip = $('chip-tooltip').getBoundingClientRect();
		if (pointerInRect(x, y, tip)) return true;
		return chipTooltipAnchor ? pointerInRect(x, y, chipTooltipAnchor.getBoundingClientRect()) : false;
	};
	document.addEventListener('mousemove', (event) => {
		if ($('chip-tooltip').hidden) return;
		if (!pointerOverTooltipArea(event.clientX, event.clientY)) hideChipTooltip();
	}, { passive: true });
	document.addEventListener('click', (event) => {
		if ($('chip-tooltip').hidden) return;
		if (!pointerOverTooltipArea(event.clientX, event.clientY)) hideChipTooltip();
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') hideChipTooltip();
	});
	window.addEventListener('scroll', hideChipTooltip, { passive: true, capture: true });

	/* ---------- settings ---------- */

	const fillSettingsForm = () => {
		$('api-key').value = settings.apiKey || '';
		$('base-url').value = settings.baseUrl || '';
		$('model-input').value = settings.model || '';
		$('default-repo').value = settings.defaultRepo || '';
		$('product-name').value = settings.productName || '';
		$('base-url').placeholder = defaults.baseUrl;
		$('model-input').placeholder = defaults.model;
	};

	const loadConfig = async () => {
		try {
			const data = await fetch('/api/config').then((r) => r.json());
			settings.apiKey = data.config.glmApiKey || '';
			settings.baseUrl = data.config.glmBaseUrl || '';
			settings.model = data.config.glmModel || '';
			settings.defaultRepo = data.config.defaultRepo || '';
			settings.productName = data.config.productName || '';
			defaults.baseUrl = data.defaults?.glmBaseUrl || defaults.baseUrl;
			defaults.model = data.defaults?.glmModel || defaults.model;
			if (data.outputDir) $('save-output-dir').textContent = data.outputDir;
			fillSettingsForm();
		} catch {
			/* defaults are fine */
		}
	};

	const saveSettings = async () => {
		settings.apiKey = $('api-key').value.trim();
		settings.baseUrl = $('base-url').value.trim();
		settings.model = $('model-input').value.trim();
		settings.defaultRepo = $('default-repo').value.trim();
		settings.productName = $('product-name').value.trim();
		await postJson('/api/config', {
			glmApiKey: settings.apiKey,
			glmBaseUrl: settings.baseUrl,
			glmModel: settings.model,
			defaultRepo: settings.defaultRepo,
			productName: settings.productName,
		});
		$('settings-dialog').close();
		toast('Settings saved.');
	};

	const testKey = async () => {
		const btn = $('key-test');
		const status = $('key-test-status');
		btn.disabled = true;
		btn.textContent = 'Testing…';
		setHint(status, 'Pinging the API with an 8-token request…');
		try {
			const data = await postJson('/api/key/test', {
				glmApiKey: $('api-key').value.trim(),
				glmBaseUrl: $('base-url').value.trim(),
				glmModel: $('model-input').value.trim(),
			});
			setHint(
				status,
				data.ok
					? `✓ Key works — model ${data.model} responded in ${data.latencyMs} ms.`
					: `✗ ${data.message}`,
				data.ok ? 'ok' : 'error',
			);
		} catch (err) {
			setHint(status, `✗ ${err.message}`, 'error');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Test key';
		}
	};

	const loadGhStatus = async () => {
		const el = $('gh-status');
		el.dataset.state = 'busy';
		el.textContent = 'gh: checking…';
		try {
			const data = await fetch('/api/gh/status').then((r) => r.json());
			el.dataset.state = data.authenticated ? 'ok' : 'error';
			el.textContent = data.authenticated ? `gh ✓ ${data.login}` : 'gh: not authenticated';
		} catch {
			el.dataset.state = 'error';
			el.textContent = 'gh: check failed';
		}
	};

	/* ---------- releases ---------- */

	/* ---------- version suggestions (semver) ---------- */

	const parseVersion = (value) => {
		const match = String(value || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i);
		if (!match) return null;
		return {
			major: Number(match[1]),
			minor: match[2] === undefined ? null : Number(match[2]),
			patch: match[3] === undefined ? null : Number(match[3]),
		};
	};

	const compareVersions = (a, b) =>
		(b.major - a.major)
		|| ((b.minor ?? 0) - (a.minor ?? 0))
		|| ((b.patch ?? 0) - (a.patch ?? 0));

	const latestReleaseVersion = () => {
		const candidates = state.releases
			.map((meta) => ({ text: meta.version, parsed: parseVersion(meta.version) }))
			.filter((candidate) => candidate.parsed)
			.sort((a, b) => compareVersions(a.parsed, b.parsed));
		return candidates[0] || null;
	};

	/**
	 * Semver bumps from the latest release: patch = bug fixes (1.18 → 1.18.1),
	 * minor = new features, backwards compatible (1.18 → 1.19 — this team's usual step),
	 * major = breaking changes (1.18 → 2.0).
	 */
	const bumpVersion = (parsed, kind) => {
		const minor = parsed.minor ?? 0;
		if (kind === 'major') return `${parsed.major + 1}.0`;
		if (kind === 'minor') return `${parsed.major}.${minor + 1}`;
		return `${parsed.major}.${minor}.${(parsed.patch ?? 0) + 1}`;
	};

	const renderVersionHints = () => {
		for (const [hintId, inputId] of [['version-hint', 'version-input'], ['new-version-hint', 'new-version']]) {
			const el = $(hintId);
			if (!el) continue;
			const latest = latestReleaseVersion();
			el.replaceChildren();
			if (!latest) {
				el.textContent = 'No previous version yet — any format works (e.g. 1.0).';
				continue;
			}
			el.appendChild(document.createTextNode(`Latest release: v${latest.text} — `));
			for (const kind of ['patch', 'minor', 'major']) {
				const chip = document.createElement('button');
				chip.type = 'button';
				chip.className = 'label-chip version-chip';
				const next = bumpVersion(latest.parsed, kind);
				chip.textContent = `${next} (${kind})`;
				chip.title = kind === 'patch'
					? 'Patch: bug fixes only'
					: kind === 'minor'
						? 'Minor: new features, backwards compatible'
						: 'Major: breaking changes';
				chip.addEventListener('click', () => {
					$(inputId).value = next;
					$(inputId).dispatchEvent(new Event('input', { bubbles: true }));
				});
				el.appendChild(chip);
				el.appendChild(document.createTextNode(' '));
			}
		}
	};

	const release = () => state.release;

	const loadReleaseList = async () => {
		state.releases = await fetch('/api/releases').then((r) => r.json());
		renderReleaseSelect();
	};

	const renderReleaseSelect = () => {
		const select = $('release-select');
		select.replaceChildren();
		for (const meta of state.releases) {
			const option = document.createElement('option');
			option.value = meta.id;
			const title = meta.version ? `v${meta.version}` : '(untitled)';
			option.textContent = `${title} · ${meta.date} · ${meta.status} · ${meta.issueCount} issues`;
			select.appendChild(option);
		}
		if (release()) select.value = release().id;
		select.disabled = state.releases.length === 0;
		$('release-delete').disabled = !release();
	};

	const renderReleaseStatus = () => {
		const el = $('release-status');
		const r = release();
		if (!r) {
			setHint(el, 'No release selected — create one to start.');
			return;
		}
		const job = state.job;
		if (r.status === 'fetching' && job) {
			setHint(el, `Fetching issues — ${job.done}/${job.total} done (${fmtSecs(job.elapsedMs)})`, 'ok');
			return;
		}
		let text = `Status: ${r.status} · ${r.issues.length} issue${r.issues.length === 1 ? '' : 's'} loaded`;
		if (r.error) text += ` — ${r.error}`;
		setHint(el, text, r.error ? 'error' : undefined);
	};

	const selectRelease = async (id) => {
		stopPolling();
		try {
			const data = await fetch(`/api/releases/${id}`).then((r) => r.json());
			if (data.error) throw new Error(data.error);
			state.release = data.release;
			state.job = data.job;
			location.hash = `r=${id}`;
			state.lastRenderedNote = '';
			renderAll();
			if (isBusyStatus(state.release.status)) startPolling();
		} catch (err) {
			toast(err.message);
		}
	};

	const newRelease = async () => {
		const version = $('new-version').value.trim();
		const date = $('new-date').value || new Date().toISOString().slice(0, 10);
		try {
			const data = await postJson('/api/releases', { version, date });
			await loadReleaseList();
			$('new-release-dialog').close();
			$('new-version').value = '';
			await selectRelease(data.release.id);
			toast(`Release ${version || '(untitled)'} created.`);
		} catch (err) {
			toast(err.message);
		}
	};

	const deleteActiveRelease = async () => {
		const r = release();
		if (!r) return;
		if (!window.confirm(`Delete release ${r.version || '(untitled)'} with its note and issue list? This cannot be undone.`)) return;
		try {
			await fetch(`/api/releases/${r.id}`, { method: 'DELETE' });
			state.release = null;
			state.job = null;
			await loadReleaseList();
			if (state.releases.length > 0) await selectRelease(state.releases[0].id);
			else renderAll();
			toast('Release deleted.');
		} catch (err) {
			toast(err.message);
		}
	};

	/* ---------- form binding (edits patch the release) ---------- */

	let patchTimer = null;
	const schedulePatch = (patch) => {
		Object.assign(release(), patch);
		clearTimeout(patchTimer);
		patchTimer = setTimeout(() => {
			postJson(`/api/releases/${release().id}`, patch, 'PATCH').catch((err) => toast(err.message));
		}, 500);
	};

	const bindReleaseField = (id, field) => {
		$(id).addEventListener('input', () => {
			if (!release() || isBusyStatus(release().status)) return;
			schedulePatch({ [field]: $(id).value });
		});
	};

	const renderForm = () => {
		const r = release();
		const busy = r ? isBusyStatus(r.status) : false;
		$('repo-input').value = r?.repo || '';
		$('version-input').value = r?.version || '';
		$('date-input').value = r?.date || new Date().toISOString().slice(0, 10);
		$('instructions-input').value = r?.instructions || '';
		for (const id of ['repo-input', 'version-input', 'date-input', 'instructions-input', 'issues-input', 'context-files']) {
			$(id).disabled = !r || busy;
		}
		$('issues-add').disabled = !r || busy || !r.repo;
		$('generate-btn').disabled = !r || busy || r.issues.length === 0 || !r.version;
		$('cancel-btn').hidden = !busy;
		$('release-delete').disabled = !r || busy;
		$('release-select').disabled = state.releases.length === 0;
		renderContextList();
	};

	/* ---------- repo access ---------- */

	const checkRepo = async () => {
		const repo = effectiveRepo();
		const status = $('repo-status');
		if (!repo) {
			setHint(status, 'Enter a repository first.', 'error');
			return;
		}
		setHint(status, 'Checking access with gh…');
		$('repo-check').disabled = true;
		try {
			const data = await postJson('/api/repo/check', { repo });
			if (data.ok) {
				const visibility = data.repo.isPrivate ? 'private' : 'public';
				setHint(status, `✓ ${data.repo.nameWithOwner} — you have ${data.repo.viewerPermission} (${visibility}${data.repo.defaultBranch ? `, default branch ${data.repo.defaultBranch}` : ''}).`, 'ok');
			} else {
				setHint(status, data.error, 'error');
			}
		} catch (err) {
			setHint(status, err.message, 'error');
		} finally {
			$('repo-check').disabled = false;
		}
	};

	/* ---------- issue list (rendered from the release) ---------- */

	const renderIssueList = () => {
		const list = $('issue-list');
		list.replaceChildren();
		const r = release();
		if (!r) return;
		for (const item of r.issues) {
			list.appendChild(renderIssueItem(item));
		}
		if (r.issues.length === 0) {
			const empty = document.createElement('li');
			empty.className = 'hint';
			empty.textContent = 'No issues yet — paste links above and press "Fetch issues". Release PRs are expanded automatically.';
			list.appendChild(empty);
		}
		renderForm(); // keep button states in sync with issue count
	};

	const renderIssueItem = (item) => {
		const li = document.createElement('li');
		li.className = item.kind === 'pull' ? 'issue-item' : 'issue-item';
		li.dataset.number = item.number;

		const num = document.createElement('span');
		num.className = 'issue-num';
		num.textContent = `#${item.number}`;
		li.appendChild(num);

		const kind = document.createElement('span');
		kind.className = 'kind-chip';
		kind.textContent = item.kind === 'pull' ? 'PR' : 'issue';
		li.appendChild(kind);

		const title = document.createElement('a');
		title.className = 'issue-title';
		title.href = item.url || '#';
		title.target = '_blank';
		title.rel = 'noopener noreferrer';
		title.textContent = item.title || '(no title)';
		// titles ellipsize — the shared custom tooltip shows the full name on hover/focus
		const showTitle = () => showChipTooltip(title, item.title || '(no title)', 'text');
		const hideTitleSoon = () => {
			clearTimeout(chipTooltipHideTimer);
			chipTooltipHideTimer = setTimeout(hideChipTooltip, 120);
		};
		title.addEventListener('mouseenter', showTitle);
		title.addEventListener('mouseleave', hideTitleSoon);
		title.addEventListener('pointerleave', hideTitleSoon);
		title.addEventListener('focus', showTitle);
		title.addEventListener('blur', hideTitleSoon);
		li.appendChild(title);

		// labels collapse into a single "N tags" chip — hover shows all of them in the shared tooltip
		const labels = item.labels || [];
		if (labels.length > 0) {
			const tagsChip = document.createElement('button');
			tagsChip.type = 'button';
			tagsChip.className = 'label-chip label-more';
			tagsChip.textContent = `${labels.length} tag${labels.length === 1 ? '' : 's'}`;
			tagsChip.setAttribute('aria-label', `${labels.length} tags: ${labels.join(', ')}`);
			const showTags = () => showChipTooltip(tagsChip, labels, 'chips');
			const hideTagsSoon = () => {
				clearTimeout(chipTooltipHideTimer);
				chipTooltipHideTimer = setTimeout(hideChipTooltip, 120);
			};
			tagsChip.addEventListener('mouseenter', showTags);
			tagsChip.addEventListener('mouseleave', hideTagsSoon);
			tagsChip.addEventListener('pointerleave', hideTagsSoon);
			tagsChip.addEventListener('focus', showTags);
			tagsChip.addEventListener('blur', hideTagsSoon);
			li.appendChild(tagsChip);
		}

		if (item.kind === 'issue') {
			const hotfixLabel = document.createElement('label');
			hotfixLabel.className = 'hotfix-toggle';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = Boolean(item.isHotfix);
			checkbox.disabled = isBusyStatus(release().status);
			checkbox.addEventListener('change', () => {
				item.isHotfix = checkbox.checked;
				schedulePatch({ issues: release().issues });
			});
			hotfixLabel.appendChild(checkbox);
			hotfixLabel.appendChild(document.createTextNode('hotfix'));
			li.appendChild(hotfixLabel);
		}

		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'btn-remove';
		remove.setAttribute('aria-label', `Remove #${item.number}`);
		remove.textContent = '×';
		remove.addEventListener('click', () => {
			const r = release();
			r.issues = r.issues.filter((other) => other !== item);
			schedulePatch({ issues: r.issues });
			renderIssueList();
		});
		li.appendChild(remove);

		return li;
	};

	const fetchIssues = async () => {
		const r = release();
		const blob = $('issues-input').value;
		if (!r) {
			toast('Create or select a release first.');
			return;
		}
		if (!blob.trim()) {
			setHint($('issues-status'), 'Paste at least one issue link or number.', 'error');
			return;
		}
		try {
			await postJson(`/api/releases/${r.id}/issues`, { inputs: blob });
			$('issues-input').value = '';
			startPolling();
		} catch (err) {
			setHint($('issues-status'), err.message, 'error');
		}
	};

	/* ---------- context files ---------- */

	const renderContextList = () => {
		const list = $('context-list');
		list.replaceChildren();
		const files = release()?.contextFiles || [];
		for (const file of files) {
			const li = document.createElement('li');
			li.className = 'context-item';
			const name = document.createElement('span');
			name.className = 'issue-title';
			name.textContent = `${file.name} (${(file.content.length / 1024).toFixed(1)} kB)`;
			li.appendChild(name);
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'btn-remove';
			remove.setAttribute('aria-label', `Remove ${file.name}`);
			remove.textContent = '×';
			remove.addEventListener('click', () => {
				const r = release();
				r.contextFiles = r.contextFiles.filter((other) => other !== file);
				schedulePatch({ contextFiles: r.contextFiles });
				renderContextList();
			});
			li.appendChild(remove);
			list.appendChild(li);
		}
	};

	const onContextFiles = async (fileList) => {
		const r = release();
		if (!r) {
			toast('Create or select a release first.');
			return;
		}
		for (const file of Array.from(fileList)) {
			if (r.contextFiles.some((existing) => existing.name === file.name)) continue;
			const content = await file.text().catch(() => '');
			if (content) r.contextFiles.push({ name: file.name, content });
		}
		schedulePatch({ contextFiles: r.contextFiles });
		renderContextList();
	};

	/* ---------- generation ---------- */

	const renderNote = () => {
		const r = release();
		const note = r?.note || '';
		if (note === state.lastRenderedNote) return;
		state.lastRenderedNote = note;
		$('output-raw').value = note;
		const target = $('output-preview');
		if (!note.trim()) {
			target.innerHTML = '<p class="placeholder">Nothing generated yet.</p>';
			return;
		}
		const html = marked.parse(note, { async: false, gfm: true, breaks: true });
		target.innerHTML = DOMPurify.sanitize(html);
	};

	const renderGenStage = () => {
		const el = $('output-status');
		const r = release();
		const job = state.job;
		if (r && isBusyStatus(r.status) && job) {
			el.classList.add('is-loading');
			el.replaceChildren();
			const spinner = document.createElement('span');
			spinner.className = 'spinner';
			spinner.setAttribute('aria-hidden', 'true');
			el.appendChild(spinner);
			const text = document.createElement('span');
			if (r.status === 'fetching') {
				text.textContent = `Fetching issues — ${job.done}/${job.total} done (${fmtSecs(job.elapsedMs)})`;
			} else if (job.phase === 'building') {
				text.textContent = 'Building the prompt…';
			} else if (job.phase === 'prompt-built') {
				text.textContent = 'Prompt built. Contacting the GLM API…';
			} else if (job.phase === 'waiting') {
				text.textContent = `Prompt accepted — waiting for the first tokens… (${fmtSecs(job.elapsedMs)})`;
			} else {
				text.textContent = `Writing the release note — ${fmtNum(job.characters)} characters · ${fmtSecs(job.elapsedMs)} elapsed`;
			}
			el.appendChild(text);
			return;
		}
		if (!r) {
			setStatus('No release selected — create one to start.');
			return;
		}
		el.classList.remove('is-loading');
		if (r.status === 'ready' && r.stats) {
			setStatus(`Done — ${fmtNum(r.stats.characters)} characters in ${fmtSecs(r.stats.elapsedMs)}${r.stats.ttfbMs ? ` (first tokens after ${fmtSecs(r.stats.ttfbMs)})` : ''}.`, 'ok');
		} else if (r.status === 'stopped') {
			setStatus(r.error || 'Stopped — partial note kept.');
		} else if (r.status === 'error') {
			setStatus(`Failed: ${r.error || 'unknown error'}`, 'error');
		} else if (r.status === 'draft') {
			setStatus(`Draft — ${r.issues.length} issue${r.issues.length === 1 ? '' : 's'} loaded. Generate when ready.`);
		} else {
			setStatus('No release note yet — add issues and generate.');
		}
	};

	const renderAll = () => {
		renderReleaseSelect();
		renderForm();
		renderIssueList();
		renderNote();
		renderGenStage();
		renderReleaseStatus();
		renderVersionHints();
		updateOutputActions();
	};

	const startGeneration = async () => {
		const r = release();
		if (!r) return;
		if (r.issues.length === 0) {
			toast('Fetch at least one issue into this release first.');
			return;
		}
		if (!r.version.trim()) {
			toast('Enter the version (e.g. 1.19) first.');
			$('version-input').focus();
			return;
		}
		try {
			await postJson(`/api/releases/${r.id}/generate`, {});
			startPolling();
		} catch (err) {
			toast(err.message);
		}
	};

	const stopGeneration = async () => {
		const r = release();
		if (!r) return;
		try {
			await postJson(`/api/releases/${r.id}/stop`, {});
			toast('Stopping…');
		} catch (err) {
			toast(err.message);
		}
	};

	/* ---------- polling (refresh-proof: the job lives server-side) ---------- */

	const startPolling = () => {
		if (state.pollTimer) return;
		state.pollTimer = setInterval(pollRelease, 800);
	};

	const stopPolling = () => {
		clearInterval(state.pollTimer);
		state.pollTimer = null;
	};

	const pollRelease = async () => {
		const r = release();
		if (!r) return;
		try {
			const data = await fetch(`/api/releases/${r.id}`).then((x) => x.json());
			if (!data || data.error) return;
			const issuesChanged = data.release.issues.length !== r.issues.length
				|| data.release.issues.some((issue, i) => r.issues[i]?.isHotfix !== issue.isHotfix);
			state.release = data.release;
			state.job = data.job;
			if (issuesChanged) renderIssueList();
			renderNote(); // no-ops unless the note changed
			renderGenStage();
			renderReleaseStatus();
			if (!isBusyStatus(state.release.status)) {
				stopPolling();
				renderAll();
				if (state.release.status === 'ready') toast('Release note ready.');
			}
		} catch {
			/* transient network blips — the next tick retries */
		}
	};

	/* ---------- output actions ---------- */

	const updateOutputActions = () => {
		const has = (release()?.note || '').trim().length > 0;
		for (const id of ['copy-btn', 'download-btn', 'save-btn']) {
			$(id).disabled = !has;
		}
		$('output-raw').disabled = !release() || isBusyStatus(release().status);
	};

	const defaultFilename = () => {
		const r = release();
		const version = (r?.version || 'x').replace(/[^A-Za-z0-9.-]+/g, '-');
		const date = (r?.date || new Date().toISOString().slice(0, 10)).replaceAll('-', '');
		return `release-note-v${version}-${date}.md`;
	};

	const copyOutput = async () => {
		try {
			await navigator.clipboard.writeText(release()?.note || '');
			toast('Release note copied to the clipboard.');
		} catch {
			toast('Clipboard blocked — use the Markdown tab and copy manually.');
		}
	};

	const downloadOutput = () => {
		const blob = new Blob([release()?.note || ''], { type: 'text/markdown;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = defaultFilename();
		link.click();
		URL.revokeObjectURL(url);
	};

	const saveOutput = () => {
		$('save-filename').value = defaultFilename();
		$('save-dialog').showModal();
	};

	const confirmSave = async () => {
		const filename = $('save-filename').value.trim();
		if (!filename) return;
		try {
			const data = await postJson('/api/save', { filename, content: release()?.note || '' });
			$('save-dialog').close();
			toast(`Saved to ${data.saved}`);
		} catch (err) {
			toast(err.message);
		}
	};

	/* ---------- tabs ---------- */

	const switchTab = (which) => {
		const preview = which === 'preview';
		$('tab-preview').classList.toggle('is-active', preview);
		$('tab-raw').classList.toggle('is-active', !preview);
		$('tab-preview').setAttribute('aria-selected', String(preview));
		$('tab-raw').setAttribute('aria-selected', String(!preview));
		$('output-preview').hidden = !preview;
		$('output-raw').hidden = preview;
	};

	/* ---------- wiring ---------- */

	$('release-select').addEventListener('change', () => selectRelease($('release-select').value));
	$('release-new').addEventListener('click', () => {
		$('new-date').value = new Date().toISOString().slice(0, 10);
		$('new-version').value = '';
		renderVersionHints();
		$('new-release-dialog').showModal();
	});
	$('new-release-create').addEventListener('click', () => newRelease());
	$('release-delete').addEventListener('click', deleteActiveRelease);

	$('repo-check').addEventListener('click', checkRepo);
	bindReleaseField('repo-input', 'repo');
	bindReleaseField('version-input', 'version');
	bindReleaseField('date-input', 'date');
	bindReleaseField('instructions-input', 'instructions');

	$('issues-add').addEventListener('click', fetchIssues);
	$('context-files').addEventListener('change', (event) => {
		onContextFiles(event.target.files);
		event.target.value = '';
	});

	$('generate-btn').addEventListener('click', startGeneration);
	$('cancel-btn').addEventListener('click', stopGeneration);

	// note editing (Markdown tab) — patches the release, debounced
	let notePatchTimer = null;
	$('output-raw').addEventListener('input', () => {
		const r = release();
		if (!r || isBusyStatus(r.status)) return;
		r.note = $('output-raw').value;
		scheduleRender();
		clearTimeout(notePatchTimer);
		notePatchTimer = setTimeout(() => {
			postJson(`/api/releases/${r.id}`, { note: r.note }, 'PATCH').catch((err) => toast(err.message));
		}, 600);
	});

	$('copy-btn').addEventListener('click', copyOutput);
	$('download-btn').addEventListener('click', downloadOutput);
	$('save-btn').addEventListener('click', saveOutput);
	$('save-confirm').addEventListener('click', confirmSave);
	$('tab-preview').addEventListener('click', () => switchTab('preview'));
	$('tab-raw').addEventListener('click', () => switchTab('raw'));

	$('open-settings').addEventListener('click', () => {
		fillSettingsForm();
		$('settings-dialog').showModal();
	});
	$('settings-save').addEventListener('click', () => {
		saveSettings().catch((err) => toast(err.message));
	});
	$('key-test').addEventListener('click', () => {
		testKey().catch((err) => toast(err.message));
	});

	/* ---------- boot ---------- */

	$('date-input').value = new Date().toISOString().slice(0, 10);
	renderGenStage();
	updateOutputActions();

	(async () => {
		await Promise.all([loadConfig(), loadGhStatus(), loadReleaseList()]);
		const hashId = (location.hash.match(/^#r=([\w-]+)$/) || [])[1];
		const target = hashId || state.releases[0]?.id;
		if (target) await selectRelease(target);
		else renderAll();
	})();
})();
