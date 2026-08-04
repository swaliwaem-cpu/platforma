export async function fulfillTrainingConfig(route, enabled) {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;

  if (request.method() !== 'GET' || pathname !== '/training/config') {
    return false;
  }

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ enabled }),
  });
  return true;
}
