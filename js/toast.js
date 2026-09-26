export function createToast() {
  const toast = document.querySelector("#toast");
  let timer = 0;
  return (message) => {
    window.clearTimeout(timer);
    toast.textContent = message;
    toast.hidden = false;
    timer = window.setTimeout(() => { toast.hidden = true; }, 2600);
  };
}
