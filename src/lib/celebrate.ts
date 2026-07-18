import confetti from "canvas-confetti";

export function celebrate(opts?: { intensity?: "small" | "big" }) {
  const big = opts?.intensity === "big";
  confetti({
    particleCount: big ? 120 : 50,
    spread: big ? 90 : 60,
    startVelocity: big ? 45 : 35,
    origin: { y: 0.7 },
    colors: ["#d4ff3a", "#f5d022", "#ff5cdb", "#ffffff"],
    scalar: big ? 1.1 : 0.9,
    ticks: 200,
  });
}