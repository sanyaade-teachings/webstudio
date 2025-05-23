import {
  parseComponentName,
  Props,
  type Instance,
  type Instances,
  type Matcher,
  type MatcherOperation,
  type MatcherRelation,
  type WebstudioFragment,
  type WsComponentMeta,
} from "@webstudio-is/sdk";
import type { InstanceSelector } from "./tree-utils";
import { isTreeSatisfyingContentModel } from "./content-model";

const isNegated = (operation?: MatcherOperation) => {
  return operation?.$neq !== undefined || operation?.$nin !== undefined;
};

const isMatching = (
  value: undefined | string,
  operation: undefined | MatcherOperation
) => {
  if (operation?.$eq) {
    return operation.$eq === value;
  }
  if (operation?.$neq) {
    return operation.$neq === value;
  }
  if (operation?.$in && value) {
    return operation.$in.includes(value);
  }
  if (operation?.$nin && value) {
    return operation.$nin.includes(value);
  }
  return false;
};

const isDepthMatchingRelation = (depth: number, relation: MatcherRelation) => {
  return (
    (relation === "self" && depth === 0) ||
    (relation === "parent" && depth === 1) ||
    (relation === "ancestor" && depth >= 1)
  );
};

const isLevelMatchingRelation = (level: number, relation: MatcherRelation) => {
  return (
    (relation === "self" && level === 0) ||
    (relation === "child" && level === 1) ||
    (relation === "descendant" && level >= 1)
  );
};

const formatList = (operation: MatcherOperation) => {
  const listFormat = new Intl.ListFormat("en", {
    type: "disjunction",
  });
  const list: string[] = [];
  if (operation.$eq) {
    list.push(operation.$eq);
  }
  if (operation.$in) {
    list.push(...operation.$in);
  }
  if (operation.$neq) {
    list.push(operation.$neq);
  }
  if (operation.$nin) {
    list.push(...operation.$nin);
  }
  return listFormat.format(
    list.map((component) => {
      const [_namespace, name] = parseComponentName(component);
      return name;
    })
  );
};

/**
 * @todo following features are missing
 * - tag matcher
 */
const isInstanceMatching = ({
  instances,
  instanceSelector,
  query,
  onError,
}: {
  instances: Instances;
  instanceSelector: InstanceSelector;
  query: undefined | Matcher | Matcher[];
  onError?: (message: string) => void;
}): boolean => {
  query = filterConstraints(query);

  // fast path to the lack of constraints
  if (query === undefined) {
    return true;
  }

  const queries = Array.isArray(query) ? query : [query];
  const matchesByMatcher = new Map<Matcher, boolean>();
  let aborted = false;
  const matchInstance = (instance: Instance, matcher: Matcher) => {
    let matches = isMatching(instance.component, matcher.component);
    if (isNegated(matcher.component)) {
      if (matches) {
        aborted = true;
        if (matcher.component) {
          onError?.(`${formatList(matcher.component)} is not acceptable`);
        }
        return;
      }
      // inverse negated match
      matches = true;
    }
    matchesByMatcher.set(
      matcher,
      (matchesByMatcher.get(matcher) ?? false) || matches
    );
  };
  let index = 0;
  for (const instanceId of instanceSelector) {
    const instance = instances.get(instanceId);
    for (const matcher of queries) {
      if (isDepthMatchingRelation(index, matcher.relation) && instance) {
        matchInstance(instance, matcher);
      }
    }
    index += 1;
  }
  const populateDescendants = (
    instanceId: Instance["id"],
    matcher: Matcher,
    level: number
  ) => {
    const instance = instances.get(instanceId);
    if (instance === undefined) {
      return;
    }
    // ignore self matchers which already handled above
    if (level > 0 && isLevelMatchingRelation(level, matcher.relation)) {
      matchInstance(instance, matcher);
    }
    for (const child of instance.children) {
      if (child.type === "id") {
        populateDescendants(child.value, matcher, level + 1);
      }
    }
  };
  for (const matcher of queries) {
    // setup default in case no children found
    matchesByMatcher.set(
      matcher,
      // negated operations matches by default
      matchesByMatcher.get(matcher) ?? isNegated(matcher.component)
    );
    populateDescendants(instanceSelector[0], matcher, 0);
  }
  if (aborted) {
    return false;
  }
  for (const matcher of queries) {
    const matches = matchesByMatcher.get(matcher) ?? false;
    if (matches === false) {
      if (matcher.component) {
        onError?.(`${formatList(matcher.component)} is missing`);
      }
      return false;
    }
  }
  return true;
};

/**
 * Added as a quick workaround!!!
 *
 * Some constraints don’t make much sense to check in this module, like relation=child and text=false.
 * They’re only used to prevent text editing of container instances.
 */
const filterConstraints = (
  constraints: Matcher | Matcher[] | undefined
): undefined | Matcher[] => {
  if (constraints === undefined) {
    return undefined;
  }

  const result = (
    Array.isArray(constraints) ? constraints : [constraints]
  ).filter(
    (constraint) => constraint.relation !== "child" || constraint.text !== false
  );
  if (result.length === 0) {
    return undefined;
  }
  return result;
};

export const isTreeMatching = ({
  instances,
  metas,
  instanceSelector,
  onError,
  level = 0,
}: {
  instances: Instances;
  metas: Map<string, WsComponentMeta>;
  instanceSelector: InstanceSelector;
  onError?: (message: string) => void;
  level?: number;
}): boolean => {
  const [instanceId] = instanceSelector;
  const instance = instances.get(instanceId);
  // collection item can be undefined
  if (instance === undefined) {
    return true;
  }
  const meta = metas.get(instance.component);
  // check self
  let matches = isInstanceMatching({
    instances,
    instanceSelector,
    query: filterConstraints(meta?.constraints),
    onError,
  });
  // check ancestors only on the first run
  if (level === 0) {
    // skip self
    for (let index = 1; index < instanceSelector.length; index += 1) {
      const instance = instances.get(instanceSelector[index]);
      if (instance === undefined) {
        continue;
      }
      const meta = metas.get(instance.component);
      const matches = isInstanceMatching({
        instances,
        instanceSelector: instanceSelector.slice(index),
        query: filterConstraints(meta?.constraints),
        onError,
      });
      if (matches === false) {
        return false;
      }
    }
  }
  if (matches === false) {
    return false;
  }
  for (const child of instance.children) {
    if (child.type === "id") {
      matches = isTreeMatching({
        instances,
        metas,
        instanceSelector: [child.value, ...instanceSelector],
        level: level + 1,
        onError,
      });
      if (matches === false) {
        return false;
      }
    }
  }
  return matches;
};

export const isInstanceDetachable = ({
  instances,
  metas,
  instanceSelector,
}: {
  instances: Instances;
  metas: Map<string, WsComponentMeta>;
  instanceSelector: InstanceSelector;
}) => {
  const [instanceId, parentId] = instanceSelector;
  const newInstances = new Map(instances);
  // replace parent with the one without selected instance
  let parentInstance = newInstances.get(parentId);
  if (parentInstance) {
    parentInstance = {
      ...parentInstance,
      children: parentInstance.children.filter(
        (child) => child.type === "id" && child.value !== instanceId
      ),
    };
    newInstances.set(parentInstance.id, parentInstance);
  }
  // skip self
  for (let index = 1; index < instanceSelector.length; index += 1) {
    const instance = newInstances.get(instanceSelector[index]);
    if (instance === undefined) {
      continue;
    }
    const meta = metas.get(instance.component);
    const matches = isInstanceMatching({
      instances: newInstances,
      instanceSelector: instanceSelector.slice(index),
      query: filterConstraints(meta?.constraints),
    });
    if (matches === false) {
      return false;
    }
  }
  return true;
};

export const findClosestInstanceMatchingFragment = ({
  instances,
  props,
  metas,
  instanceSelector,
  fragment,
  onError,
}: {
  instances: Instances;
  props: Props;
  metas: Map<string, WsComponentMeta>;
  instanceSelector: InstanceSelector;
  // require only subset of fragment
  fragment: Pick<WebstudioFragment, "children" | "instances" | "props">;
  onError?: (message: string) => void;
}) => {
  const mergedInstances = new Map(instances);
  for (const instance of fragment.instances) {
    mergedInstances.set(instance.id, instance);
  }
  const mergedProps = new Map(props);
  for (const prop of fragment.props) {
    mergedProps.set(prop.id, prop);
  }
  let firstError = "";
  for (let index = 0; index < instanceSelector.length; index += 1) {
    const instanceId = instanceSelector[index];
    const instance = instances.get(instanceId);
    // collection item can be undefined
    if (instance === undefined) {
      continue;
    }
    const meta = metas.get(instance.component);
    if (meta === undefined) {
      continue;
    }
    let matches = true;
    for (const child of fragment.children) {
      if (child.type === "id") {
        const childInstanceSelector = [
          child.value,
          ...instanceSelector.slice(index),
        ];
        matches &&= isTreeMatching({
          instances: mergedInstances,
          metas,
          instanceSelector: childInstanceSelector,
          onError: (message) => {
            if (firstError === "") {
              firstError = message;
            }
          },
        });
        matches &&= isTreeSatisfyingContentModel({
          instances: mergedInstances,
          props: mergedProps,
          metas,
          instanceSelector: childInstanceSelector,
          onError: (message) => {
            if (firstError === "") {
              firstError = message;
            }
          },
        });
      }
    }
    if (matches) {
      return index;
    }
  }
  onError?.(firstError);
  return -1;
};

export const __testing__ = {
  isInstanceMatching,
};
