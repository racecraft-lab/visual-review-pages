import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Agentation } from 'agentation'

import {
  annotationCommentBody,
  annotationPointIntersectsImage,
  annotationStorageKey,
  imageCoordinatesFromAnnotation,
  resolvePullRequestCommentPlacement,
} from './visual-review-annotations.mjs'

const root = document.getElementById('visual-annotation-root')
const visualReviewThemeStorageKey = 'visual-review:theme'
installAgentationImageBoundsGuard()

if (root) {
  createRoot(root).render(<AnnotationApp />)
}

function AnnotationApp() {
  const [report, setReport] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [asset, setAsset] = useState(new URLSearchParams(window.location.search).get('asset') || 'current')
  const [token, setToken] = useState('')
  const [githubUser, setGithubUser] = useState('')
  const [tokenStatus, setTokenStatus] = useState('Token optional')
  const [annotations, setAnnotations] = useState([])
  const [editingAnnotationId, setEditingAnnotationId] = useState('')
  const [editingComment, setEditingComment] = useState('')
  const [boundsStatus, setBoundsStatus] = useState('')
  const [posting, setPosting] = useState(false)
  const [postStatus, setPostStatus] = useState('')
  const [prFiles, setPrFiles] = useState(null)
  const [zoom, setZoom] = useState(100)
  const imageRef = useRef(null)
  const desktop = useDesktopQuery()
  const [theme, setTheme] = useState(initialVisualReviewTheme)

  useEffect(() => {
    applyVisualReviewTheme(theme)
    localStorage.setItem(visualReviewThemeStorageKey, theme)
  }, [theme])

  useEffect(() => {
    loadReportData()
      .then(setReport)
      .catch((error) => setLoadError(error.message))
  }, [])

  const items = useMemo(() => report ? buildItems(report.payload) : [], [report])
  const initialId = new URLSearchParams(window.location.search).get('id')
  const item = items.find((candidate) => candidate.id === initialId) || items[0]
  const context = report?.context || {}
  const selectedAsset = item ? assetForItem(item, asset) : null
  const target = item ? inlineCommentTarget(item) : null
  const storageKey = item && selectedAsset
    ? annotationStorageKey({ asset: selectedAsset.kind, context, itemId: item.id })
    : ''

  useEffect(() => {
    const storedToken = sessionStorage.getItem(githubTokenKey(context)) || ''
    setToken(storedToken)
    setGithubUser('')
    setTokenStatus(storedToken ? 'Token entered' : 'Token optional')
  }, [context.repository, context.prNumber])

  useEffect(() => {
    if (!storageKey) return
    setAnnotations(readAnnotations(storageKey))
    setEditingAnnotationId('')
    setEditingComment('')
    setBoundsStatus('')
    setPostStatus('')
  }, [storageKey])

  useEffect(() => {
    const handleBlockedAnnotation = () => {
      setBoundsStatus('Annotation ignored. Click directly inside the reviewed image.')
    }
    window.addEventListener('visual-review-annotation-blocked', handleBlockedAnnotation)
    return () => window.removeEventListener('visual-review-annotation-blocked', handleBlockedAnnotation)
  }, [])

  useEffect(() => {
    if (selectedAsset && selectedAsset.kind !== asset) setAsset(selectedAsset.kind)
  }, [asset, selectedAsset])

  useEffect(() => {
    const handleAnnotationHotkey = (event) => {
      if (event.__visualReviewAnnotationHotkeyHandled) return
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (String(event.key || '').toLowerCase() !== 'a') return
      if (isTextEntryTarget(event.target)) return

      event.__visualReviewAnnotationHotkeyHandled = true
      event.preventDefault()
      toggleAgentationFeedbackMode()
    }

    window.addEventListener('keydown', handleAnnotationHotkey, true)
    document.addEventListener('keydown', handleAnnotationHotkey, true)
    return () => {
      window.removeEventListener('keydown', handleAnnotationHotkey, true)
      document.removeEventListener('keydown', handleAnnotationHotkey, true)
    }
  }, [])

  const persistAnnotations = useCallback((nextAnnotations) => {
    setAnnotations(nextAnnotations)
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(nextAnnotations))
  }, [storageKey])

  const handleAgentationAnnotation = useCallback((agentationAnnotation) => {
    if (!item || !selectedAsset || !imageRef.current) return
    const imageRect = imageRef.current.getBoundingClientRect()
    const naturalSize = {
      width: imageRef.current.naturalWidth || imageRect.width,
      height: imageRef.current.naturalHeight || imageRect.height,
    }
    const viewport = {
      scrollY: window.scrollY,
      width: window.innerWidth,
    }
    if (!annotationPointIntersectsImage({ annotation: agentationAnnotation, imageRect, viewport })) {
      setBoundsStatus('Annotation ignored. Click directly inside the reviewed image.')
      return
    }
    const coordinates = imageCoordinatesFromAnnotation({
      annotation: agentationAnnotation,
      imageRect,
      naturalSize,
      viewport,
    })
    setBoundsStatus('')
    const wrapped = {
      schemaVersion: 1,
      id: agentationAnnotation.id,
      comment: String(agentationAnnotation.comment || '').trim(),
      agentation: agentationAnnotation,
      github: { status: 'pending' },
      image: {
        ...coordinates,
        naturalHeight: naturalSize.height,
        naturalWidth: naturalSize.width,
        rawFile: item.raw,
        url: selectedAsset.url,
        valid: true,
      },
      review: {
        annotationPageUrl: window.location.href,
        asset: selectedAsset.kind,
        headSha: context.headSha,
        itemId: item.id,
        prNumber: context.prNumber,
        repository: context.repository,
        reviewPageUrl: reviewPageHref(item),
        runKey: context.runKey,
        runUrl: context.runUrl,
        snapshot: item.raw,
        surface: context.surface,
      },
      target: target
        ? {
            href: sourceFileHref(context, target),
            line: target.line,
            path: target.path,
          }
        : {
            href: null,
            line: null,
            path: null,
          },
    }
    persistAnnotations(upsertAnnotation(annotations, wrapped))
    window.setTimeout(deactivateAgentationFeedbackMode, 0)
  }, [annotations, context, item, persistAnnotations, selectedAsset, target])

  const startAnnotationEdit = useCallback((annotation) => {
    setEditingAnnotationId(annotation.id)
    setEditingComment(annotation.comment || '')
  }, [])

  const cancelAnnotationEdit = useCallback(() => {
    setEditingAnnotationId('')
    setEditingComment('')
  }, [])

  const saveAnnotationEdit = useCallback((annotationId) => {
    const nextComment = editingComment.trim()
    const nextAnnotations = annotations.map((annotation) => {
      if (annotation.id !== annotationId) return annotation
      return {
        ...annotation,
        agentation: {
          ...annotation.agentation,
          comment: nextComment,
        },
        comment: nextComment,
        github: annotation.github?.status === 'posted'
          ? { status: 'pending' }
          : annotation.github,
      }
    })
    persistAnnotations(nextAnnotations)
    cancelAnnotationEdit()
    setPostStatus('')
  }, [annotations, cancelAnnotationEdit, editingComment, persistAnnotations])

  const removeAnnotationDraft = useCallback((annotationId) => {
    persistAnnotations(annotations.filter((annotation) => annotation.id !== annotationId))
    if (editingAnnotationId === annotationId) cancelAnnotationEdit()
    setPostStatus('')
  }, [annotations, cancelAnnotationEdit, editingAnnotationId, persistAnnotations])

  const clearAnnotationDrafts = useCallback(() => {
    persistAnnotations([])
    cancelAnnotationEdit()
    setBoundsStatus('')
    setPostStatus('')
  }, [cancelAnnotationEdit, persistAnnotations])

  const handleAnnotationDelete = useCallback((agentationAnnotation) => {
    removeAnnotationDraft(agentationAnnotation.id)
  }, [removeAnnotationDraft])

  const handleAnnotationsClear = useCallback(() => {
    clearAnnotationDrafts()
  }, [clearAnnotationDrafts])

  async function saveGithubToken() {
    const nextToken = token.trim()
    if (!nextToken) {
      sessionStorage.removeItem(githubTokenKey(context))
      setGithubUser('')
      setTokenStatus('Token cleared.')
      return
    }
    sessionStorage.setItem(githubTokenKey(context), nextToken)
    setTokenStatus('Checking GitHub token...')
    try {
      const user = await githubRequest('/user', { context, token: nextToken })
      setGithubUser(user.login || '')
      setTokenStatus(`Signed in @${user.login || 'GitHub user'}`)
    } catch (error) {
      setTokenStatus(error.message)
    }
  }

  async function postPendingAnnotations() {
    if (!token.trim()) {
      setPostStatus('GitHub token required to post annotation comments.')
      return
    }
    const pending = annotations.filter((annotation) => annotation.github?.status !== 'posted')
    if (pending.length === 0) {
      setPostStatus('No pending annotations to post.')
      return
    }

    setPosting(true)
    setPostStatus('Posting annotation comments...')
    const nextAnnotations = [...annotations]
    try {
      const files = prFiles || await loadPullRequestFiles({ context, token })
      if (!prFiles) setPrFiles(files)
      for (const annotation of pending) {
        const placement = resolvePullRequestCommentPlacement({
          files,
          target: annotation.target,
        })
        const body = annotationCommentBody({
          annotation,
          placementReason: placement.reason,
        })
        const response = placement.kind === 'timeline'
          ? await githubRequest(`/repos/${context.repository}/issues/${context.prNumber}/comments`, {
              body: { body },
              context,
              method: 'POST',
              token,
            })
          : await githubRequest(`/repos/${context.repository}/pulls/${context.prNumber}/comments`, {
              body: {
                ...placement.body,
                body,
                commit_id: context.headSha,
                path: annotation.target.path,
              },
              context,
              method: 'POST',
              token,
            })
        const index = nextAnnotations.findIndex((candidate) => candidate.id === annotation.id)
        if (index >= 0) {
          nextAnnotations[index] = {
            ...nextAnnotations[index],
            github: {
              commentId: response?.id || null,
              htmlUrl: response?.html_url || '',
              placement: placement.kind,
              status: 'posted',
            },
          }
        }
      }
      persistAnnotations(nextAnnotations)
      setPostStatus(`Posted ${pending.length} annotation comment${pending.length === 1 ? '' : 's'} to PR #${context.prNumber}.`)
    } catch (error) {
      setPostStatus(error.message)
    } finally {
      setPosting(false)
    }
  }

  if (loadError) {
    return (
      <main className="annotation-empty">
        <h1>Unable to load visual report</h1>
        <p>{loadError}</p>
      </main>
    )
  }

  if (!report || !item || !selectedAsset) {
    return (
      <main className="annotation-empty">
        <h1>Loading annotation review</h1>
      </main>
    )
  }

  return (
    <div className="annotation-shell">
      <header className="topbar annotation-topbar">
        <div className="topbar-inner">
          <div className="topbar-title">
            <nav className="crumbs" aria-label="Breadcrumb">
              <a href={context.prIndexHref}>PR #{context.prNumber}</a>
              <span>/</span>
              <a href={reviewPageHref(item)}>{context.surfaceLabel}</a>
              <span>/</span>
              <span>Image annotation</span>
            </nav>
            <h1>{itemTitle(item)}</h1>
            <div className="meta-row">
              <span>{statusLabel(item.variant)}</span>
              <span>{itemSubtitle(item)}</span>
              <span>Commit {shortSha(context.headSha)}</span>
            </div>
          </div>
          <div
            className="annotation-actions"
            data-annotation-control
            onClick={stopAnnotationControlEvent}
            onMouseDown={stopAnnotationControlEvent}
            onPointerDown={stopAnnotationControlEvent}
          >
            <button
              aria-pressed={theme === 'dark'}
              className="btn theme-toggle"
              onClick={() => setTheme(toggleVisualReviewTheme(theme))}
              type="button"
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <a className="btn" href={reviewPageHref(item)}>Back to queue</a>
            <a className="btn" href={selectedAsset.url} target="_blank" rel="noopener noreferrer">Open raw image</a>
          </div>
        </div>
      </header>

      <main className="annotation-workspace">
        <section className="annotation-canvas" aria-label="Selected visual artifact">
          <article className="viewer-card annotation-viewer-card">
            <div className="viewer-toolbar">
              <div className="snapshot-heading">
                <h2>{selectedAsset.label}</h2>
                <p>{item.raw}</p>
              </div>
              <div className="toolbar-controls">
                <div className="segmented" role="group" aria-label="Image asset">
                  {assetOptions(item).map((option) => (
                    <button
                      className={selectedAsset.kind === option.kind ? 'active' : ''}
                      data-asset={option.kind}
                      key={option.kind}
                      onClick={() => setAsset(option.kind)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <label className="range-row">
                  Zoom
                  <input
                    max="200"
                    min="50"
                    onChange={(event) => setZoom(Number(event.target.value))}
                    step="1"
                    type="range"
                    value={zoom}
                  />
                  <span>{zoom}%</span>
                </label>
              </div>
            </div>
            <div className="stage annotation-stage">
              <div className="stage-inner annotation-stage-inner" style={{ zoom: zoom / 100 }}>
                <div className="annotation-image-frame" data-annotation-frame>
                  <img
                    alt={`${selectedAsset.label} for ${item.raw}`}
                    className="solo-image annotation-image-target"
                    data-annotation-image
                    ref={imageRef}
                    src={selectedAsset.url}
                  />
                  <div className="annotation-image-marker-layer" aria-hidden="true">
                    {annotations.map((annotation, index) => (
                      <span
                        className={`annotation-image-marker ${annotation.github?.status || 'pending'}`}
                        key={annotation.id}
                        style={{
                          left: cssPercent(annotation.image?.xPct),
                          top: cssPercent(annotation.image?.yPct),
                        }}
                        title={annotation.comment || 'Image annotation'}
                      >
                        {index + 1}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </article>
        </section>

        <aside
          aria-label="Image annotation workflow"
          className="annotation-review-panel"
          data-annotation-control
          onClick={stopAnnotationControlEvent}
          onMouseDown={stopAnnotationControlEvent}
          onPointerDown={stopAnnotationControlEvent}
        >
          <section className="annotation-card">
            <div className="brief-topline">
              <span>Image annotations</span>
              <span className="decision-pill open">{annotations.length} local</span>
            </div>
            <h2>Mark the image, then post PR comments</h2>
            <p className="brief-description">
              Annotations are saved in this browser for PR #{context.prNumber}. Posting creates review comments with image coordinates for future remediation.
            </p>
            {!desktop ? (
              <div className="inline-comment-target missing">
                <span>Desktop required</span>
                <strong>Agentation annotations are not available on mobile.</strong>
                <p>Open this page on a desktop browser to mark the screenshot.</p>
              </div>
            ) : (
              <ol className="sync-steps annotation-steps">
                <li><span>1</span><p><strong>Activate Agentation</strong> from the floating toolbar or press <kbd>A</kbd>.</p></li>
                <li><span>2</span><p><strong>Mark the image</strong> and describe what needs to change.</p></li>
                <li><span>3</span><p><strong>Review drafts</strong> below. Edit, remove, or clear them before posting.</p></li>
                <li><span>4</span><p><strong>Post to PR</strong> to leave durable reviewer context.</p></li>
              </ol>
            )}
            {boundsStatus ? <p className="comment-status error">{boundsStatus}</p> : null}
          </section>

          <section className="annotation-card">
            <div className="annotation-section-header">
              <h3>Pending annotation comments</h3>
              {annotations.length > 0 ? (
                <button className="btn" onClick={clearAnnotationDrafts} type="button">Clear all annotations</button>
              ) : null}
            </div>
            {annotations.length === 0 ? (
              <p className="annotation-muted">No annotations saved for this image yet.</p>
            ) : (
              <div className="annotation-list">
                {annotations.map((annotation, index) => (
                  <article className={`annotation-note ${annotation.github?.status || 'pending'}`} key={annotation.id}>
                    <div className="annotation-note-main">
                      {editingAnnotationId === annotation.id ? (
                        <label className="annotation-edit-form">
                          <span>Edit annotation {index + 1}</span>
                          <textarea
                            aria-label={`Edit annotation comment ${index + 1}`}
                            className="annotation-edit-field"
                            onChange={(event) => setEditingComment(event.target.value)}
                            rows="3"
                            value={editingComment}
                          />
                        </label>
                      ) : (
                        <>
                          <strong>{annotation.comment || 'Annotation without comment'}</strong>
                          <p>
                            Image coordinate: {annotation.image.pixelX}, {annotation.image.pixelY} px ({formatPercent(annotation.image.xPct)}%, {formatPercent(annotation.image.yPct)}%)
                          </p>
                          {annotation.github?.htmlUrl ? <a href={annotation.github.htmlUrl} target="_blank" rel="noopener noreferrer">Open PR comment</a> : null}
                        </>
                      )}
                    </div>
                    <div className="annotation-note-side">
                      <span>{annotation.github?.status || 'pending'}</span>
                      {editingAnnotationId === annotation.id ? (
                        <div className="annotation-note-actions">
                          <button className="btn primary" onClick={() => saveAnnotationEdit(annotation.id)} type="button">Save annotation {index + 1}</button>
                          <button className="btn" onClick={cancelAnnotationEdit} type="button">Cancel edit annotation {index + 1}</button>
                        </div>
                      ) : (
                        <div className="annotation-note-actions">
                          <button className="btn" onClick={() => startAnnotationEdit(annotation)} type="button">Edit annotation {index + 1}</button>
                          <button className="btn" onClick={() => removeAnnotationDraft(annotation.id)} type="button">Remove annotation {index + 1}</button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="annotation-card">
            <h3>GitHub posting</h3>
            <div className="sync-status-line">
              <span>Status</span>
              <strong>{githubUser ? `@${githubUser}` : tokenStatus}</strong>
            </div>
            <label className="token-field">
              <span>GitHub token</span>
              <input
                className="token-input"
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste token for PR review comments"
                type="password"
                value={token}
              />
              <small>Stored only in this tab's sessionStorage.</small>
            </label>
            <div className="sync-action-group">
              <button className="btn" onClick={saveGithubToken} type="button">Use token</button>
              <button className="btn primary" disabled={posting || annotations.length === 0} onClick={postPendingAnnotations} type="button">Post to PR</button>
            </div>
            {postStatus ? <p className="comment-status ready">{postStatus}</p> : null}
            <p className="annotation-muted">Posting annotations does not approve this image. Return to the queue for final disposition.</p>
          </section>
        </aside>
      </main>

      {desktop ? (
        <Agentation
          className="agentation-review-toolbar"
          copyToClipboard={false}
          onAnnotationAdd={handleAgentationAnnotation}
          onAnnotationDelete={handleAnnotationDelete}
          onAnnotationUpdate={handleAgentationAnnotation}
          onAnnotationsClear={handleAnnotationsClear}
        />
      ) : null}
    </div>
  )
}

async function loadReportData() {
  const inline = document.getElementById('visual-review-data')?.textContent
  if (inline) return JSON.parse(inline)

  const indexResponse = await fetch('./index.html', { cache: 'no-store' })
  if (!indexResponse.ok) throw new Error(`index.html returned ${indexResponse.status}`)
  const indexHtml = await indexResponse.text()
  const parsed = parseVisualReviewData(indexHtml)
  if (parsed) return parsed

  const regVizResponse = await fetch('./reg-viz.html', { cache: 'no-store' })
  if (!regVizResponse.ok) throw new Error('Visual report data was not found in index.html or reg-viz.html.')
  const payload = parseRegVizPayload(await regVizResponse.text())
  return { context: {}, payload }
}

function parseVisualReviewData(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const script = doc.getElementById('visual-review-data')
  if (!script?.textContent) return null
  return JSON.parse(script.textContent)
}

function parseRegVizPayload(html) {
  const match = html.match(/window\[['"]__reg__['"]\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)
  if (!match) throw new Error('reg-viz.html did not contain a window.__reg__ payload.')
  return JSON.parse(match[1])
}

function buildItems(payload) {
  return [
    ...reportItems(payload, 'failedItems').map((item) => buildItem(payload, item, 'changed')),
    ...reportItems(payload, 'newItems').map((item) => buildItem(payload, item, 'new')),
    ...reportItems(payload, 'deletedItems').map((item) => buildItem(payload, item, 'deleted')),
    ...reportItems(payload, 'passedItems').map((item) => buildItem(payload, item, 'passed')),
  ]
}

function buildItem(payload, item, variant) {
  const fileName = item.encoded || item.raw
  const id = `${variant}-${fileName}`.replace(/[=?&]/g, '-')
  const raw = item.raw || fileName
  const review = normalizeReviewMetadata(item.review || item.visualMetadata || item.metadata)
  return {
    actual: joinUrl(payload.actualDir, fileName),
    diff: joinUrl(payload.diffDir, diffFileName(payload, fileName)),
    encoded: fileName,
    expected: joinUrl(payload.expectedDir, fileName),
    id,
    raw,
    review,
    variant,
  }
}

function reportItems(payload, key) {
  return Array.isArray(payload?.[key]) ? payload[key] : []
}

function normalizeReviewMetadata(value) {
  if (!value || typeof value !== 'object') return null
  const titlePath = stringArray(value.testTitlePath)
  return {
    description: stringOr(value.description),
    domain: stringOr(value.domain),
    expected: stringOr(value.expected),
    focus: stringArray(value.focus),
    kind: stringOr(value.kind),
    sourceFile: stringOr(value.sourceFile),
    storyId: stringOr(value.storyId),
    storyName: stringOr(value.storyName),
    storyTitle: stringOr(value.storyTitle),
    subtitle: stringOr(value.subtitle) || (titlePath.length ? titlePath.join(' > ') : '') || stringOr(value.sourceFile),
    tags: stringArray(value.tags),
    testTitle: stringOr(value.testTitle),
    testTitlePath: titlePath,
    title: stringOr(value.title),
  }
}

function assetForItem(item, requestedAsset) {
  return assetOptions(item).find((option) => option.kind === requestedAsset) || assetOptions(item)[0]
}

function assetOptions(item) {
  return [
    item.actual && item.variant !== 'deleted' ? { kind: 'current', label: 'Current image', url: item.actual } : null,
    item.expected && item.variant !== 'new' ? { kind: 'baseline', label: 'Baseline image', url: item.expected } : null,
    item.diff && item.variant === 'changed' ? { kind: 'diff', label: 'Diff image', url: item.diff } : null,
  ].filter(Boolean)
}

async function loadPullRequestFiles({ context, token }) {
  const files = []
  for (let page = 1; page <= 30; page += 1) {
    const batch = await githubRequest(`/repos/${context.repository}/pulls/${context.prNumber}/files?per_page=100&page=${page}`, {
      context,
      token,
    })
    if (!Array.isArray(batch) || batch.length === 0) break
    files.push(...batch)
    if (batch.length < 100) break
  }
  return files
}

async function githubRequest(path, { body, context, method = 'GET', token }) {
  const trimmedToken = token.trim()
  if (!trimmedToken) throw new Error('GitHub token required.')
  const response = await fetch(`https://api.github.com${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${trimmedToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-github-api-version': '2022-11-28',
    },
    method,
  })

  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after')
    let detail = ''
    try {
      detail = (await response.json()).message || ''
    } catch {
      detail = response.statusText
    }
    const suffix = retryAfter ? ` Retry after ${retryAfter}s.` : ''
    throw new Error(`GitHub API ${response.status} for PR #${context.prNumber}: ${detail}${suffix}`)
  }

  return response.status === 204 ? null : response.json()
}

function readAnnotations(storageKey) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(parsed)
      ? parsed.filter((annotation) => annotation?.image?.valid !== false)
      : []
  } catch {
    return []
  }
}

function upsertAnnotation(annotations, annotation) {
  const index = annotations.findIndex((candidate) => candidate.id === annotation.id)
  if (index < 0) return [...annotations, annotation]
  return annotations.map((candidate, candidateIndex) => candidateIndex === index ? annotation : candidate)
}

function reviewPageHref(item) {
  const url = new URL('./index.html', window.location.href)
  url.searchParams.set('id', item.id)
  return url.href
}

function inlineCommentTarget(item) {
  return parseSourceReference(item.review?.sourceFile || item.review?.subtitle || '')
}

function parseSourceReference(value) {
  const candidate = String(value || '').split(' > ')[0].trim()
  if (!candidate) return null
  const match = candidate.match(/^(.+?):(\d+)(?::\d+)?$/)
  const path = (match ? match[1] : candidate).replace(/^\/+/, '')
  if (!path || /\s/.test(path)) return null
  return {
    line: match ? Number(match[2]) : null,
    path,
  }
}

function sourceFileHref(context, target) {
  if (!target?.path || !context.repository) return context.prUrl || ''
  const line = target.line ? `#L${target.line}` : ''
  return `https://github.com/${context.repository}/blob/${context.headSha}/${target.path}${line}`
}

function joinUrl(base, fileName) {
  const normalizedBase = `${String(base || '').replace(/\/$/, '')}/`
  return new URL(String(fileName || '').replace(/^\//, ''), new URL(normalizedBase, window.location.href)).href
}

function diffFileName(payload, fileName) {
  const extension = String(payload.diffImageExtention || payload.diffImageExtension || 'webp').replace(/^\./, '')
  const slash = fileName.lastIndexOf('/')
  const dir = slash >= 0 ? fileName.slice(0, slash + 1) : ''
  const leaf = slash >= 0 ? fileName.slice(slash + 1) : fileName
  const dot = leaf.lastIndexOf('.')
  const stem = dot >= 0 ? leaf.slice(0, dot) : leaf
  return `${dir}${stem}.${extension}`
}

function itemTitle(item) {
  return item.review?.title || humanizeSnapshotName(item.raw)
}

function itemSubtitle(item) {
  return item.review?.subtitle || item.review?.sourceFile || item.raw
}

function humanizeSnapshotName(fileName) {
  const leaf = String(fileName || '').split('/').pop() || fileName
  return leaf
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || fileName
}

function githubTokenKey(context) {
  return `visual-review:${context.repository}:${context.prNumber}:github-token`
}

function initialVisualReviewTheme() {
  const stored = localStorage.getItem(visualReviewThemeStorageKey)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyVisualReviewTheme(theme) {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

function toggleVisualReviewTheme(currentTheme) {
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark'
  applyVisualReviewTheme(nextTheme)
  localStorage.setItem(visualReviewThemeStorageKey, nextTheme)
  return nextTheme
}

function statusLabel(variant) {
  return {
    changed: 'Changed',
    deleted: 'Deleted',
    new: 'New',
    passed: 'Unchanged',
  }[variant] || variant
}

function stringOr(value) {
  return typeof value === 'string' && value.length > 0 ? value : ''
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
}

function shortSha(value) {
  return String(value || '').slice(0, 7) || 'unknown'
}

function formatPercent(value) {
  return Number(value).toLocaleString('en-US', {
    maximumFractionDigits: 3,
    useGrouping: false,
  })
}

function cssPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '0%'
  return `${Math.max(0, Math.min(100, numeric))}%`
}

function toggleAgentationFeedbackMode() {
  if (isAgentationFeedbackModeActive()) {
    deactivateAgentationFeedbackMode()
    return
  }

  activateAgentationFeedbackMode()
}

function activateAgentationFeedbackMode(attempt = 0) {
  if (attempt === 0) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyF',
      ctrlKey: true,
      key: 'f',
      shiftKey: true,
    }))
  }

  if (attempt < 12) {
    window.setTimeout(() => {
      if (document.getElementById('feedback-cursor-styles')) return

      const startButton = document.querySelector('[title="Start feedback mode"]')
      if (startButton && typeof startButton.click === 'function') {
        startButton.click()
        return
      }

      activateAgentationFeedbackMode(attempt + 1)
    }, attempt === 0 ? 100 : 50)
    return
  }
}

function deactivateAgentationFeedbackMode(attempt = 0) {
  if (!isAgentationFeedbackModeActive()) return

  document.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'KeyF',
    ctrlKey: true,
    key: 'f',
    shiftKey: true,
  }))

  if (attempt < 5) {
    window.setTimeout(() => deactivateAgentationFeedbackMode(attempt + 1), 100)
  }
}

function isAgentationFeedbackModeActive() {
  if (document.getElementById('feedback-cursor-styles')) return true
  const toolbar = document.querySelector('[data-agentation-toolbar]')
  const startButton = document.querySelector('[title="Start feedback mode"]')
  return Boolean(toolbar && !startButton)
}

function stopAnnotationControlEvent(event) {
  event.stopPropagation()
}

function isTextEntryTarget(target) {
  if (!target || target.nodeType !== 1) return false
  const element = target
  const tagName = element.tagName
  return tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    element.isContentEditable ||
    Boolean(element.closest?.('[contenteditable="true"]'))
}

function installAgentationImageBoundsGuard() {
  if (typeof window === 'undefined' || window.__visualReviewImageBoundsGuardInstalled) return
  window.__visualReviewImageBoundsGuardInstalled = true

  const guard = (event) => {
    if (!document.getElementById('feedback-cursor-styles')) return
    if (event.defaultPrevented || isAgentationControlEvent(event)) return

    const image = document.querySelector('[data-annotation-image]')
    if (!image) return

    const rect = image.getBoundingClientRect()
    const pointInsideImage = event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom

    if (pointInsideImage) return

    event.preventDefault()
    event.stopPropagation()
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
    window.dispatchEvent(new CustomEvent('visual-review-annotation-blocked', {
      detail: { reason: 'outside-image' },
    }))
  }
  document.addEventListener('pointerdown', guard, true)
  document.addEventListener('mousedown', guard, true)
  document.addEventListener('click', guard, true)
}

function isAgentationControlEvent(event) {
  return isAnnotationControlEvent(event) || eventPath(event).some((entry) => {
    if (!entry || entry.nodeType !== 1 || typeof entry.matches !== 'function') return false
    return entry.matches('[data-agentation-toolbar], [data-agentation-toolbar] *, [data-annotation-popup], [data-annotation-popup] *, [data-annotation-marker], [data-annotation-marker] *')
  })
}

function isAnnotationControlEvent(event) {
  return eventPath(event).some((entry) => {
    if (!entry || entry.nodeType !== 1 || typeof entry.matches !== 'function') return false
    return entry.matches('[data-annotation-control], [data-annotation-control] *')
  })
}

function eventPath(event) {
  if (typeof event.composedPath === 'function') return event.composedPath()
  const path = []
  let current = event.target
  while (current) {
    path.push(current)
    current = current.parentNode
  }
  return path
}

function useDesktopQuery() {
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 781px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 781px)')
    const handleChange = () => setDesktop(query.matches)
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])
  return desktop
}
