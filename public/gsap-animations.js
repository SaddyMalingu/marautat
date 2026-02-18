// GSAP Animation Example
window.addEventListener('DOMContentLoaded', () => {
  if (window.gsap) {
    gsap.from('.gsap-animate', {
      opacity: 0,
      y: 40,
      duration: 1.2,
      stagger: 0.2
    });
  }
});
