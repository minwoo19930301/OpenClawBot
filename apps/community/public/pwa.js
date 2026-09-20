const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  navigator.standalone === true;

const base64ToBytes = (value) => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

export function createPwaController({ api, getSession, toast }) {
  const installButtons = [
    document.querySelector("#install-button"),
    document.querySelector("#auth-install-button"),
  ].filter(Boolean);
  const pushButton = document.querySelector("#push-button");
  const testPushButton = document.querySelector("#test-push-button");
  const dialog = document.querySelector("#pwa-dialog");
  const dialogTitle = document.querySelector("#pwa-dialog-title");
  const dialogMessage = document.querySelector("#pwa-dialog-message");
  const state = {
    session: null,
    registration: null,
    config: null,
    subscription: null,
    deferredInstall: null,
    supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
  };

  const showDialog = (title, message) => {
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    if (!dialog.open) dialog.showModal();
  };
  const renderInstall = () => {
    const available = Boolean(state.deferredInstall || (isIOS && !isStandalone()));
    installButtons.forEach((button) => {
      button.classList.toggle("is-hidden", !available);
      button.textContent = isIOS && !state.deferredInstall ? "홈 화면에 추가" : "앱으로 설치";
    });
  };
  const renderPush = () => {
    const available = Boolean(state.session) && state.supported && state.config?.configured;
    const permission = state.supported ? Notification.permission : "default";
    pushButton.classList.toggle("is-hidden", !available);
    testPushButton.classList.toggle("is-hidden", !available || !state.subscription);
    pushButton.disabled = false;
    pushButton.textContent = state.subscription ? "알림 끄기" :
      permission === "denied" ? "알림 차단됨" : "알림 켜기";
  };
  const syncSubscription = async (subscription) => {
    if (!subscription || !state.session) return;
    await api("/api/push/subscriptions", {
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
  };
  const loadPushConfig = async () => {
    if (!state.supported || !state.session) return;
    const sessionId = state.session.user?.id;
    try {
      state.config = await api("/api/push/config");
      if (!state.session || state.session.user?.id !== sessionId) return;
      if (!state.config?.configured || !state.config.publicKey) {
        renderPush();
        return;
      }
      state.registration ||= await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      state.registration = await navigator.serviceWorker.ready;
      if (!state.session || state.session.user?.id !== sessionId) return;
      const subscription = await state.registration.pushManager.getSubscription();
      if (subscription) {
        try {
          await syncSubscription(subscription);
          state.subscription = subscription;
        } catch (error) {
          if (error.status === 409) {
            await subscription.unsubscribe().catch(() => {});
            state.subscription = null;
            toast("이 기기의 기존 알림 구독을 정리했습니다. 알림을 다시 켜주세요.");
          } else throw error;
        }
      }
    } catch (error) {
      state.config = null;
      toast(error.message || "알림 설정을 확인하지 못했습니다.");
    }
    renderPush();
  };
  const enablePush = async () => {
    if (!state.config?.configured || !state.config.publicKey || !state.session) return;
    if (Notification.permission === "denied") {
      showDialog("알림이 차단되어 있습니다", "브라우저 설정에서 이 사이트의 알림을 허용한 뒤 다시 시도해주세요.");
      return;
    }
    pushButton.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        renderPush();
        return;
      }
      state.registration ||= await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      state.registration = await navigator.serviceWorker.ready;
      const subscription = await state.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToBytes(state.config.publicKey),
      });
      try {
        await syncSubscription(subscription);
        state.subscription = subscription;
      } catch (error) {
        await subscription.unsubscribe().catch(() => {});
        state.subscription = null;
        throw error;
      }
      toast("이제 새 메시지 알림을 받을 수 있어요.");
    } catch (error) {
      toast(error.message || "알림을 켜지 못했습니다.");
    } finally {
      renderPush();
    }
  };
  const disablePush = async () => {
    const subscription = state.subscription || await state.registration?.pushManager.getSubscription();
    if (!subscription) return;
    pushButton.disabled = true;
    try {
      await api("/api/push/subscriptions", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
      state.subscription = null;
      toast("메시지 알림을 껐어요.");
    } catch (error) {
      toast(error.message || "알림을 끄지 못했습니다.");
    } finally {
      renderPush();
    }
  };
  const testPush = async () => {
    if (!state.subscription || !state.session) return;
    testPushButton.disabled = true;
    try {
      await api("/api/push/test", {
        method: "POST",
        body: JSON.stringify({ endpoint: state.subscription.endpoint }),
      });
      toast("테스트 알림을 요청했습니다. 기기에서 확인해 주세요.");
    } catch (error) {
      toast(error.message || "테스트 알림을 요청하지 못했습니다.");
    } finally {
      testPushButton.disabled = false;
    }
  };
  const install = async () => {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      renderInstall();
      return;
    }
    if (isIOS) {
      showDialog("홈 화면에 추가", "공유 버튼을 누른 뒤 ‘홈 화면에 추가’를 선택하면 앱처럼 사용할 수 있어요. 설치 후 알림을 켜려면 홈 화면에서 다시 열어주세요.");
    }
  };
  installButtons.forEach((button) => button.addEventListener("click", install));
  pushButton.addEventListener("click", () => state.subscription ? disablePush() : enablePush());
  testPushButton.addEventListener("click", testPush);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    renderInstall();
  });
  window.addEventListener("appinstalled", () => {
    state.deferredInstall = null;
    renderInstall();
    toast("홈 화면에 앱을 설치했습니다.");
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
    state.registration = registration;
  }).catch(() => {});
  renderInstall();
  renderPush();
  return {
    setSession(session) {
      state.session = session;
      if (!session) {
        state.config = null;
        state.subscription = null;
      }
      renderInstall();
      renderPush();
      if (session) loadPushConfig();
    },
    async clearSession({ keepSession = false } = {}) {
      const subscription = state.subscription ||
        (state.session && state.registration
          ? await state.registration.pushManager.getSubscription().catch(() => null)
          : null);
      if (subscription && state.session) {
        try {
          await api("/api/push/subscriptions", {
            method: "DELETE",
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
        } catch {}
        await subscription.unsubscribe().catch(() => {});
      }
      state.subscription = null;
      if (!keepSession) {
        state.session = null;
        state.config = null;
      }
      renderInstall();
      renderPush();
    },
  };
}
