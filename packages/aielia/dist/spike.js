import { jsx, jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { render, useInput, Box, Text } from "ink";
function Spike() {
  const [lastKey, setLastKey] = useState("(none yet)");
  useInput((input, key) => {
    if (key.escape || key.ctrl && input === "c") {
      process.exit(0);
    }
    setLastKey(key.return ? "<enter>" : input || JSON.stringify(key));
  });
  return /* @__PURE__ */ jsx(Box, { borderStyle: "round", padding: 1, children: /* @__PURE__ */ jsxs(Text, { children: [
    "Ink spike — hello world. Last key: ",
    lastKey
  ] }) });
}
render(/* @__PURE__ */ jsx(Spike, {}));
//# sourceMappingURL=spike.js.map
