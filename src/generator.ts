import {memoize, omit} from 'lodash'
import {DEFAULT_OPTIONS, Options} from './index'
import {
  AST,
  ASTWithStandaloneName,
  hasComment,
  hasStandaloneName,
  T_ANY,
  TArray,
  TEnum,
  TInterface,
  TIntersection,
  TNamedInterface,
  TUnion,
  T_UNKNOWN,
} from './types/AST'
import {log, toSafeString} from './utils'

export function generate(ast: AST, options = DEFAULT_OPTIONS): string {
  return (
    [
      options.bannerComment,
      importDependencies(ast, options),
      declareNamedTypes(ast, options, ast.standaloneName!),
      declareNamedInterfaces(ast, options, ast.standaloneName!),
      declareEnums(ast, options),
    ]
      .filter(Boolean)
      .join('\n\n') + '\n'
  ) // trailing newline
}

function declareEnums(ast: AST, options: Options, processed = new Set<AST>()): string {
  if (processed.has(ast)) {
    return ''
  }

  processed.add(ast)
  let type = ''

  switch (ast.type) {
    case 'ENUM':
      return generateStandaloneEnum(ast, options) + '\n'
    case 'ARRAY':
      return declareEnums(ast.params, options, processed)
    case 'UNION':
    case 'INTERSECTION':
      return ast.params.reduce((prev, ast) => prev + declareEnums(ast, options, processed), '')
    case 'TUPLE':
      type = ast.params.reduce((prev, ast) => prev + declareEnums(ast, options, processed), '')
      if (ast.spreadParam) {
        type += declareEnums(ast.spreadParam, options, processed)
      }
      return type
    case 'INTERFACE':
      return getSuperTypesAndParams(ast).reduce((prev, ast) => prev + declareEnums(ast, options, processed), '')
    default:
      return ''
  }
}

function declareNamedInterfaces(ast: AST, options: Options, rootASTName: string, processed = new Set<AST>()): string {
  if (processed.has(ast)) {
    return ''
  }

  processed.add(ast)
  let type = ''

  switch (ast.type) {
    case 'ARRAY':
      type = declareNamedInterfaces((ast as TArray).params, options, rootASTName, processed)
      break
    case 'INTERFACE':
      type = [
        hasStandaloneName(ast) &&
          (ast.standaloneName === rootASTName || options.declareExternallyReferenced) &&
          generateStandaloneInterface(ast, options),
        getSuperTypesAndParams(ast)
          .map(ast => declareNamedInterfaces(ast, options, rootASTName, processed))
          .filter(Boolean)
          .join('\n'),
      ]
        .filter(Boolean)
        .join('\n')
      break
    case 'INTERSECTION':
    case 'TUPLE':
    case 'UNION':
      type = ast.params
        .map(_ => declareNamedInterfaces(_, options, rootASTName, processed))
        .filter(Boolean)
        .join('\n')
      if (ast.type === 'TUPLE' && ast.spreadParam) {
        type += declareNamedInterfaces(ast.spreadParam, options, rootASTName, processed)
      }
      break
    default:
      type = ''
  }

  return type
}

function declareNamedTypes(ast: AST, options: Options, rootASTName: string, processed = new Set<AST>()): string {
  if (processed.has(ast)) {
    return ''
  }

  processed.add(ast)

  switch (ast.type) {
    case 'ARRAY':
      return [
        declareNamedTypes(ast.params, options, rootASTName, processed),
        hasStandaloneName(ast) ? generateStandaloneType(ast, options) : undefined,
      ]
        .filter(Boolean)
        .join('\n')
    case 'ENUM':
      return ''
    case 'INTERFACE':
      return getSuperTypesAndParams(ast)
        .map(
          ast =>
            (ast.standaloneName === rootASTName || options.declareExternallyReferenced) &&
            declareNamedTypes(ast, options, rootASTName, processed),
        )
        .filter(Boolean)
        .join('\n')
    case 'INTERSECTION':
    case 'TUPLE':
    case 'UNION':
      return [
        hasStandaloneName(ast) ? generateStandaloneType(ast, options) : undefined,
        ast.params
          .map(ast => declareNamedTypes(ast, options, rootASTName, processed))
          .filter(Boolean)
          .join('\n'),
        'spreadParam' in ast && ast.spreadParam
          ? declareNamedTypes(ast.spreadParam, options, rootASTName, processed)
          : undefined,
      ]
        .filter(Boolean)
        .join('\n')
    default:
      if (hasStandaloneName(ast)) {
        return generateStandaloneType(ast, options)
      }
      return ''
  }
}

function generateTypeUnmemoized(ast: AST, options: Options): string {
  const type = generateRawType(ast, options)

  if (options.strictIndexSignatures && ast.keyName === '[k: string]') {
    return `${type} | undefined`
  }

  return type
}
export const generateType = memoize(generateTypeUnmemoized)

function generateRawType(ast: AST, options: Options): string {
  log('magenta', 'generator', ast)

  if (hasStandaloneName(ast)) {
    return toSafeString(ast.standaloneName)
  }

  switch (ast.type) {
    case 'ANY':
      return 'any'
    case 'ARRAY':
      return (() => {
        const type = generateType(ast.params, options)
        return type.endsWith('"') ? '(' + type + ')[]' : type + '[]'
      })()
    case 'BOOLEAN':
      return 'boolean'
    case 'INTERFACE':
      return generateInterface(ast, options)
    case 'INTERSECTION':
      return generateSetOperation(ast, options)
    case 'LITERAL':
      if (options.generateClassValidator && typeof ast.params === 'string') {
        return escapeKeyName(String(ast.params).toUpperCase()) + '=' + JSON.stringify(ast.params) // To be clarified!
      } else {
        return JSON.stringify(ast.params)
      }
    case 'NEVER':
      return 'never'
    case 'NUMBER':
      return 'number'
    case 'NULL':
      return 'null'
    case 'OBJECT':
      return 'object'
    case 'REFERENCE':
      return ast.params
    case 'STRING':
      return 'string'
    case 'TUPLE':
      if (options.generateClassValidator) {
        return generateType(ast.params[0], options) // TODO - this is for sure not the final version ;)
      }
      return (() => {
        const minItems = ast.minItems
        const maxItems = ast.maxItems || -1

        let spreadParam = ast.spreadParam
        const astParams = [...ast.params]
        if (minItems > 0 && minItems > astParams.length && ast.spreadParam === undefined) {
          // this is a valid state, and JSONSchema doesn't care about the item type
          if (maxItems < 0) {
            // no max items and no spread param, so just spread any
            spreadParam = options.unknownAny ? T_UNKNOWN : T_ANY
          }
        }
        if (maxItems > astParams.length && ast.spreadParam === undefined) {
          // this is a valid state, and JSONSchema doesn't care about the item type
          // fill the tuple with any elements
          for (let i = astParams.length; i < maxItems; i += 1) {
            astParams.push(options.unknownAny ? T_UNKNOWN : T_ANY)
          }
        }

        function addSpreadParam(params: string[]): string[] {
          if (spreadParam) {
            const spread = '...(' + generateType(spreadParam, options) + ')[]'
            params.push(spread)
          }
          return params
        }

        function paramsToString(params: string[]): string {
          return '[' + params.join(', ') + ']'
        }

        const paramsList = astParams.map(param => generateType(param, options))

        if (paramsList.length > minItems) {
          /*
        if there are more items than the min, we return a union of tuples instead of
        using the optional element operator. This is done because it is more typesafe.

        // optional element operator
        type A = [string, string?, string?]
        const a: A = ['a', undefined, 'c'] // no error

        // union of tuples
        type B = [string] | [string, string] | [string, string, string]
        const b: B = ['a', undefined, 'c'] // TS error
        */

          const cumulativeParamsList: string[] = paramsList.slice(0, minItems)
          const typesToUnion: string[] = []

          if (cumulativeParamsList.length > 0) {
            // actually has minItems, so add the initial state
            typesToUnion.push(paramsToString(cumulativeParamsList))
          } else {
            // no minItems means it's acceptable to have an empty tuple type
            typesToUnion.push(paramsToString([]))
          }

          for (let i = minItems; i < paramsList.length; i += 1) {
            cumulativeParamsList.push(paramsList[i])

            if (i === paramsList.length - 1) {
              // only the last item in the union should have the spread parameter
              addSpreadParam(cumulativeParamsList)
            }

            typesToUnion.push(paramsToString(cumulativeParamsList))
          }

          return typesToUnion.join('|')
        }

        // no max items so only need to return one type
        return paramsToString(addSpreadParam(paramsList))
      })()
    case 'UNION':
      if (options.generateClassValidator) {
        return generateEnum(ast, options)
      } else {
        return generateSetOperation(ast, options)
      }
    case 'UNKNOWN':
      return 'unknown'
    case 'CUSTOM_TYPE':
      return ast.params
  }
}

/**
 * Generate an Enum
 */
function generateEnum(ast: TIntersection | TUnion, options: Options): string {
  // export enum DimensionType {
  //   FLAT_FEE = 'flatFee',
  //   ENERGY = 'energy',
  //   CHARGING_TIME = 'chargingTime',
  //   PARKING_TIME = 'parkingTime'
  // }
  const members = (ast as TUnion).params.map(_ => generateType(_, options))
  const separator = ',\n'
  return members.length === 1 ? members[0] : '{\n' + members.join(separator) + '\n}\n'
}

/**
 * Generate a Union or Intersection
 */
function generateSetOperation(ast: TIntersection | TUnion, options: Options): string {
  const members = (ast as TUnion).params.map(_ => generateType(_, options))
  const separator = ast.type === 'UNION' ? '|' : '&'
  return members.length === 1 ? members[0] : '(' + members.join(' ' + separator + ' ') + ')'
}

function generateInterface(ast: TInterface, options: Options): string {
  return (
    `{` +
    '\n\n' +
    ast.params
      .filter(_ => !_.isPatternProperty && !_.isUnreachableDefinition)
      .map(
        ({isRequired, keyName, ast}) =>
          [isRequired, keyName, ast, generateType(ast, options)] as [boolean, string, AST, string],
      )
      .map(
        ([isRequired, keyName, ast, type]) =>
          (hasComment(ast) && !ast.standaloneName ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
          annotateProperty(ast, type, options) +
          annotateOptionalProperty(ast, keyName, type, isRequired, options) +
          annotateWithConcreteType(ast, keyName, type, options) +
          generatePropertyDeclaration(ast, keyName, type, isRequired, options),
      )
      .join('\n') +
    '\n' +
    '}'
  )
}

function generateComment(comment?: string, deprecated?: boolean): string {
  const commentLines = ['/**']
  if (deprecated) {
    commentLines.push(' * @deprecated')
  }
  if (typeof comment !== 'undefined') {
    commentLines.push(...comment.split('\n').map(_ => ' * ' + _))
  }
  commentLines.push(' */')
  return commentLines.join('\n')
}

function generateStandaloneEnum(ast: TEnum, options: Options): string {
  return (
    (hasComment(ast) ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
    'export ' +
    (options.enableConstEnums ? 'const ' : '') +
    `enum ${toSafeString(ast.standaloneName)} {` +
    '\n' +
    ast.params.map(({ast, keyName}) => keyName + ' = ' + generateType(ast, options)).join(',\n') +
    '\n' +
    '}'
  )
}

function generateStandaloneInterface(ast: TNamedInterface, options: Options): string {
  const exportType = options.generateClassValidator ? 'class' : 'interface'
  return (
    (hasComment(ast) ? generateComment(ast.comment, ast.deprecated) + '\n' : '') +
    `export ${exportType} ${toSafeString(ast.standaloneName)} ` +
    (ast.superTypes.length > 0
      ? `extends ${ast.superTypes.map(superType => toSafeString(superType.standaloneName)).join(', ')} `
      : '') +
    generateInterface(ast, options)
  )
}

function generateStandaloneType(ast: ASTWithStandaloneName, options: Options): string {
  if (options.generateClassValidator && ast.type === 'UNION') {
    return (
      (hasComment(ast) ? generateComment(ast.comment) + '\n' : '') +
      `export enum ${toSafeString(ast.standaloneName)} ${generateType(
        omit<AST>(ast, 'standaloneName') as AST /* TODO */,
        options,
      )}`
    )
  } else {
    return (
      (hasComment(ast) ? generateComment(ast.comment) + '\n' : '') +
      `export type ${toSafeString(ast.standaloneName)} = ${generateType(
        omit<AST>(ast, 'standaloneName') as AST /* TODO */,
        options,
      )}`
    )
  }
}

function escapeKeyName(keyName: string): string {
  if (keyName.length && /[A-Za-z_$]/.test(keyName.charAt(0)) && /^[\w$]+$/.test(keyName)) {
    return keyName
  }
  if (keyName === '[k: string]') {
    return keyName
  }
  return JSON.stringify(keyName)
}

function getSuperTypesAndParams(ast: TInterface): AST[] {
  return ast.params.map(param => param.ast).concat(ast.superTypes)
}

function annotateProperty(_ast: AST, type: string, options: Options): string {
  let annotation = null
  if (options.generateClassValidator) {
    switch (type) {
      case 'string':
        annotation = '@IsString()'
        break
      case 'number':
        annotation = '@IsNumber()'
        break
      case 'boolean':
        annotation = '@IsBoolean()'
        break
      default:
        // HACK - to be clarified
        if (!type.includes('unknown')) {
          annotation = `@ValidateNested()`
        }
    }
  }
  return annotation ? annotation + '\r' : ''
}

function annotateOptionalProperty(
  _ast: AST,
  _keyName: string,
  type: string,
  isRequired: boolean,
  options: Options,
): string {
  let annotation = null
  if (options.generateClassValidator && !isRequired && !type.includes('unknown')) {
    annotation = `@IsOptional()`
  }
  return annotation ? annotation + '\r' : ''
}

function annotateWithConcreteType(ast: AST, _keyName: string, type: string, options: Options): string {
  let annotation = null
  const generateAnArray = type.includes('[]')
  type = type.replace('[]', '')

  if (options.generateClassValidator) {
    switch (type) {
      case 'string':
      case 'number':
      case 'boolean':
        break
      default:
        if (type.includes('unknown')) {
          // annotation = null // HACK!
        } else if (ast.type === 'TUPLE' || generateAnArray) {
          annotation = `@IsArray()`
          // HACK - HACK - HACK - parser has a bug! - no way to properly handle an array of enum values
          if (type.toLowerCase().includes('enum')) {
            annotation += `\n@IsEnum(${type})`
          } else {
            annotation += `\n@Type(() => ${type})`
          }
        } else if (ast.type === 'UNION') {
          annotation = `@IsEnum(${type})`
        } else {
          annotation = `@Type(() => ${type})`
        }
    }
  }
  return annotation ? annotation + '\r' : ''
}

function generatePropertyDeclaration(
  ast: AST,
  keyName: string,
  type: string,
  isRequired: boolean,
  options: Options,
): string {
  const required = isRequired ? '' : '?'

  if (options.generateClassValidator && ast.type !== 'UNKNOWN') {
    const suffix = ast.type === 'TUPLE' ? '[]' : ''
    return `public ${escapeKeyName(keyName)}${required}: ${type}${suffix};\n`
  } else {
    return `${escapeKeyName(keyName)}${required}: ${type};\n`
  }
}

function importDependencies(_ast: AST, options: Options): string {
  if (options.generateClassValidator) {
    return `
    import { Type } from 'class-transformer';
    import {
      IsArray,
      IsBoolean,
      IsEnum,
      IsNumber,
      IsOptional,
      IsString,
      Matches,
      ValidateNested
    } from 'class-validator';`
  } else {
    return ''
  }
}
