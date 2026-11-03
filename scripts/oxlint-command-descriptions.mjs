const callTo = (node, method) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === "Command" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === method;

export default {
  meta: { name: "devver" },
  rules: {
    "command-description": {
      meta: {
        type: "problem",
        docs: { description: "Require descriptions for Effect CLI commands" },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!callTo(node, "make")) {
              return;
            }
            const pipe = node.parent;
            const chained = pipe?.parent;
            const described =
              pipe?.type === "MemberExpression" &&
              pipe.object === node &&
              pipe.property.type === "Identifier" &&
              pipe.property.name === "pipe" &&
              chained?.type === "CallExpression" &&
              chained.callee === pipe &&
              chained.arguments.some(
                (argument) =>
                  callTo(argument, "withDescription") &&
                  argument.arguments[0]?.type === "Literal" &&
                  typeof argument.arguments[0].value === "string" &&
                  argument.arguments[0].value.trim() !== ""
              );
            if (!described) {
              context.report({
                node,
                message:
                  'Add .pipe(Command.withDescription("...")) to this command',
              });
            }
          },
        };
      },
    },
  },
};
