'use strict';

function mapAssistantProductSubmission(content, resolution, retainedGeo = null) {
  if (resolution?.status === 'NOT_APPLICABLE') {
    return {
      status: 'READY',
      body: { content, ...(retainedGeo ? { geo: retainedGeo } : {}) },
    };
  }
  const resolvedConstraints = resolution?.status === 'COMPOSITE'
    ? resolution.constraints
    : [resolution];
  if (!Array.isArray(resolvedConstraints) || resolvedConstraints.length === 0
    || resolvedConstraints.some((constraint) => constraint?.status !== 'RESOLVED'
      || constraint.candidates?.length !== 1
      || typeof constraint.slotId !== 'string'
      || !constraint.sourceSpan)) {
    return { status: 'CONFIRMATION_REQUIRED' };
  }
  const constraints = resolvedConstraints.map((constraint) => {
    const candidate = constraint.candidates[0];
    return {
      referenceType: 'LANDMARK',
      landmarkId: candidate.id,
      mode: candidate.mode,
      ...(candidate.mode === 'NEAR' ? { distanceMeters: candidate.distanceMeters } : {}),
      slotId: constraint.slotId,
      sourceSpan: constraint.sourceSpan,
    };
  });
  return {
    status: 'READY',
    body: {
      content,
      geo: resolution.status === 'COMPOSITE'
        ? { operator: 'ALL', constraints }
        : constraints[0],
    },
  };
}

module.exports = { mapAssistantProductSubmission };
